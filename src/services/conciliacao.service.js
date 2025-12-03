// src/services/conciliacao.service.js
import { processFile } from "../utils/files.js";
import OpenAI from "openai";

// Cliente OpenAI lazy (só cria se tiver chave)
let openaiClient = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }

  return openaiClient;
}

/**
 * Normaliza textos para comparação robusta:
 * - remove acentos
 * - ignora maiúsculas/minúsculas
 * - remove quebras de linha e múltiplos espaços
 * - remove caracteres especiais estranhos vindos do PDF
 */
function normalizarTexto(str) {
  if (!str) return "";

  return String(str)
    .normalize("NFD") // separa acentos
    .replace(/[\u0300-\u036f]/g, "") // remove marcas de acento
    .replace(/[\r\n]+/g, " ") // remove quebras de linha
    .replace(/\s+/g, " ") // compacta espaços múltiplos em 1
    .replace(/[^\w\s]/g, " ") // remove pontuação estranha
    .trim()
    .toLowerCase();
}

/**
 * Verifica se o fornecedor aparece na razão usando
 * uma busca mais tolerante (fuzzy por tokens).
 *
 * Regras:
 * - Primeiro tenta match exato no texto normalizado inteiro;
 * - Depois quebra em linhas e verifica se, em alguma linha,
 *   pelo menos ~70% das palavras do fornecedor aparecem.
 */
function fornecedorExisteNaRazao(nomeFornecedor, textoRazaoBruto) {
  if (!nomeFornecedor || !textoRazaoBruto) return false;

  const alvo = normalizarTexto(nomeFornecedor);
  if (!alvo) return false;

  const textoNormalizado = normalizarTexto(textoRazaoBruto);

  // 1) Tentativa simples: substring direta no texto todo
  if (textoNormalizado.includes(alvo)) {
    return true;
  }

  // 2) Tentativa por tokens linha a linha (mais tolerante)
  const tokensAlvo = alvo
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 2); // ignora "de", "sa", "e", etc.

  if (tokensAlvo.length === 0) return false;

  const linhas = String(textoRazaoBruto)
    .split(/\r?\n/)
    .map((linha) => normalizarTexto(linha))
    .filter(Boolean);

  for (const linha of linhas) {
    let encontrados = 0;

    for (const token of tokensAlvo) {
      if (linha.includes(token)) {
        encontrados++;
      }
    }

    const score = encontrados / tokensAlvo.length;

    // se encontrou pelo menos 70% das palavras do fornecedor na linha,
    // consideramos que o fornecedor está presente naquela linha
    if (score >= 0.7) {
      return true;
    }
  }

  return false;
}

/**
 * Extrai linhas do texto bruto onde o fornecedor aparece
 * (usando a mesma lógica de score de tokens).
 *
 * Além disso, captura todos os valores monetários da linha
 * (padrão 9.999,99) e guarda o último valor encontrado,
 * que normalmente é o saldo da coluna final.
 */
function extrairLinhasFornecedor(textoBruto, nomeFornecedor) {
  if (!textoBruto || !nomeFornecedor) return [];

  const alvoNorm = normalizarTexto(nomeFornecedor);
  if (!alvoNorm) return [];

  const tokensAlvo = alvoNorm
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 2);

  if (tokensAlvo.length === 0) return [];

  const linhas = String(textoBruto).split(/\r?\n/);

  const resultado = [];

  for (const linhaOriginal of linhas) {
    const linhaNorm = normalizarTexto(linhaOriginal);
    if (!linhaNorm) continue;

    let encontrados = 0;
    for (const token of tokensAlvo) {
      if (linhaNorm.includes(token)) encontrados++;
    }

    const score = tokensAlvo.length ? encontrados / tokensAlvo.length : 0;

    // um pouquinho mais tolerante aqui (0.6) para pegar quebra de linha estranha
    if (score >= 0.6) {
      const numerosMonetarios = [];
      const regexValor = /(\d{1,3}(?:\.\d{3})*,\d{2})/g;
      let m;
      while ((m = regexValor.exec(linhaOriginal)) !== null) {
        numerosMonetarios.push(m[1]);
      }

      resultado.push({
        linhaOriginal: linhaOriginal.trim(),
        linhaNormalizada: linhaNorm,
        scoreMatch: score,
        numerosMonetarios,
        ultimoNumero: numerosMonetarios.length
          ? numerosMonetarios[numerosMonetarios.length - 1]
          : null,
      });
    }
  }

  return resultado;
}

/**
 * Converte string "42.151,99" em número 42151.99
 */
function parseValorMonetario(valorStr) {
  if (!valorStr) return null;
  const limpo = String(valorStr)
    .replace(/\./g, "")
    .replace(/[^\d,-]/g, "")
    .replace(",", ".");
  const num = Number.parseFloat(limpo);
  return Number.isFinite(num) ? num : null;
}

/**
 * Monta indicadores objetivos de saldo para o fornecedor
 * em cada relatório (usando texto COMPLETO, não apenas amostra).
 *
 * Isso é usado para:
 * - dar pistas mais confiáveis para a IA;
 * - impedir que a IA invente divergência de saldo
 *   quando os relatórios, na prática, batem.
 */
function montarIndicadoresFornecedor(fornecedor, textosPorRelatorio = {}) {
  const indicadoresFornecedor = {};
  const saldosNumericosPorRelatorio = {};

  const chavesRelatorios = ["balancete", "contas_pagar", "razao"];

  for (const chave of chavesRelatorios) {
    const texto = textosPorRelatorio[chave] || "";
    const linhasFornecedor = extrairLinhasFornecedor(texto, fornecedor);

    const saldosEncontrados = [];

    for (const linha of linhasFornecedor) {
      if (!linha.ultimoNumero) continue;
      const valorNum = parseValorMonetario(linha.ultimoNumero);
      if (valorNum !== null) {
        saldosEncontrados.push({
          texto: linha.ultimoNumero,
          numero: valorNum,
          linhaOriginal: linha.linhaOriginal,
        });
      }
    }

    if (saldosEncontrados.length > 0) {
      saldosNumericosPorRelatorio[chave] = saldosEncontrados.map(
        (s) => s.numero
      );
    }

    indicadoresFornecedor[chave] = {
      linhasFornecedor,
      saldosEncontrados,
    };
  }

  // Avaliação automática simples dos saldos
  let avaliacaoAutomaticaSaldo = {
    status: "dados_insuficientes",
    descricao:
      "Não foi possível comparar saldos de forma automática com segurança.",
  };

  const todasChavesComSaldo = Object.keys(saldosNumericosPorRelatorio);
  if (todasChavesComSaldo.length >= 2) {
    const todosValores = todasChavesComSaldo.flatMap(
      (k) => saldosNumericosPorRelatorio[k]
    );

    const min = Math.min(...todosValores);
    const max = Math.max(...todosValores);

    if (Number.isFinite(min) && Number.isFinite(max)) {
      const diff = Math.abs(max - min);

      // Se a diferença máxima for menor ou igual a 0,10
      // consideramos que são, na prática, o mesmo saldo.
      if (diff <= 0.1) {
        avaliacaoAutomaticaSaldo = {
          status: "saldos_iguais",
          descricao:
            "Os saldos identificados automaticamente nos relatórios são praticamente iguais para o fornecedor.",
          valorReferenciaAproximado: Number(
            ((min + max) / 2).toFixed(2)
          ),
        };
      } else {
        avaliacaoAutomaticaSaldo = {
          status: "saldos_diferentes",
          descricao:
            "Foram encontrados saldos numéricos diferentes entre os relatórios para este fornecedor.",
        };
      }
    }
  }

  return { indicadoresFornecedor, avaliacaoAutomaticaSaldo };
}

/**
 * Rodada 1: processamento inicial dos arquivos enviados
 * - Lê PDFs / Excel via processFile
 * - Normaliza em um formato padrão
 */
export async function prepararRodada1({ fornecedor, arquivos }) {
  const resultado = {};

  for (const [chave, fileInfo] of Object.entries(arquivos || {})) {
    if (!fileInfo) continue;

    const processado = await processFile(fileInfo);

    resultado[chave] = {
      nomeOriginal: fileInfo.originalname,
      caminho: fileInfo.path,
      mimetype: fileInfo.mimetype,
      processado,
    };
  }

  return {
    fornecedor,
    status: "arquivos_processados",
    mensagem:
      "Arquivos lidos e convertidos com sucesso. Pronto para iniciar a conciliação (Rodada 1).",
    relatorios: resultado,
  };
}

/**
 * Rodada 2 (dentro da API): usa a IA para gerar uma conciliação inteligente
 * a partir dos relatórios já processados na Rodada 1.
 *
 * ATENÇÃO:
 * - Aqui não lemos arquivo de novo.
 * - Só usamos o que veio de prepararRodada1 (texto já extraído).
 */
export async function realizarConciliacao({
  fornecedor,
  relatoriosProcessados,
  simulacao = false,
}) {
  const openai = getOpenAIClient();

  // Se não tiver chave, não derruba a API
  if (!openai) {
    return {
      fornecedor,
      simulacao,
      status: "erro_openai",
      mensagem:
        "OPENAI_API_KEY não configurada. Adicione sua chave no arquivo .env para habilitar a conciliação com IA.",
    };
  }

  // 🔹 1) PRIMEIRO: usar o TEXTO COMPLETO da razão para checar se o fornecedor existe
  const razaoProcessado = relatoriosProcessados?.razao?.processado || {};
  const razaoTextoCompleto =
    razaoProcessado.conteudoTexto || razaoProcessado.preview || "";

  const fornecedorEncontrado = fornecedorExisteNaRazao(
    fornecedor,
    razaoTextoCompleto
  );

  if (!fornecedorEncontrado) {
    // 🚫 Não achou o fornecedor na razão → não chama IA
    const estruturaJson = {
      resumoExecutivo: `Não foram encontrados lançamentos do fornecedor "${fornecedor}" na razão enviada.`,
      composicaoSaldo: [
        {
          fonte: "razao",
          descricao:
            "Razão de fornecedores analisada, porém o fornecedor informado não consta em nenhum lançamento.",
          valorEstimado: 0,
          observacoes:
            "Verifique se o relatório de razão está filtrado corretamente para o período e empresa, ou se há erro no nome do fornecedor.",
        },
      ],
      divergencias: [
        {
          descricao:
            "Fornecedor informado não aparece em nenhum lançamento da razão de fornecedores.",
          tipo: "fornecedor_sem_lancamento",
          referencias: [
            `Fornecedor: ${fornecedor}`,
            "Relatório: Razão de Fornecedores",
          ],
          nivelCriticidade: "alta",
        },
      ],
      pagamentosOrfaos: [],
      titulosVencidosSemContrapartida: [],
      passosRecomendados: [
        "Conferir se o nome do fornecedor está idêntico ao cadastrado no sistema/contabilidade.",
        "Validar se o relatório de razão foi emitido para o CNPJ correto e para o período desejado.",
        "Caso o fornecedor realmente devesse ter lançamentos, solicitar ao responsável a emissão de um novo relatório de razão filtrado corretamente.",
      ],
      observacoesGerais:
        "Como o fornecedor não foi encontrado na amostra do relatório de razão, não é possível prosseguir com a conciliação detalhada até que os relatórios estejam consistentes.",
    };

    return {
      fornecedor,
      simulacao,
      status: "conciliacao_gerada",
      modelo: "regra_local_sem_ia",
      entradaIA: null,
      estrutura: estruturaJson,
      respostaBruta:
        "Fornecedor não encontrado na razão. Diagnóstico gerado sem chamada ao modelo de IA.",
    };
  }

  // 🔹 2) Se chegou aqui, o fornecedor EXISTE na razão → montamos o resumo pra IA

  const relatoriosResumidos = {};

  for (const [chave, info] of Object.entries(relatoriosProcessados || {})) {
    const proc = info?.processado || {};

    relatoriosResumidos[chave] = {
      nomeOriginal: info?.nomeOriginal || null,
      tipo: proc?.tipo || null,
      tamanhoTexto: proc?.tamanhoTexto || null,
      preview: proc?.preview || null,
      // 🔹 Aqui sim, usamos só um TRECHO pra não explodir token
      trechoConteudo: proc?.conteudoTexto
        ? String(proc.conteudoTexto).slice(0, 8000)
        : null,
    };
  }

  // 🔹 2.1) Textos COMPLETOS para montar indicadores objetivos por relatório
  const textosCompletos = {
    razao: razaoTextoCompleto,
    balancete:
      relatoriosProcessados?.balancete?.processado?.conteudoTexto || "",
    contas_pagar:
      relatoriosProcessados?.contas_pagar?.processado?.conteudoTexto || "",
  };

  const { indicadoresFornecedor, avaliacaoAutomaticaSaldo } =
    montarIndicadoresFornecedor(fornecedor, textosCompletos);

  const entradaIA = {
    fornecedor,
    relatorios: relatoriosResumidos,
    indicadoresFornecedor,
    avaliacaoAutomaticaSaldo,
  };

  // 🔹 3) Fluxo normal com IA
  const systemPrompt = `
Você é um analista contábil brasileiro especialista em CONCILIAÇÃO DE FORNECEDORES.

Contexto:
- Você recebe RESUMOS de 4 relatórios: razão de fornecedores, balancete, contas a pagar e extrato de pagamentos.
- Para cada relatório, você recebe:
  - nomeOriginal
  - tipo
  - tamanhoTexto
  - preview (primeiras linhas)
  - trechoConteudo (primeira parte do texto real, quando disponível)
- Os textos originais podem ser muito grandes, então você trabalha com AMOSTRAS.

Além disso, você recebe um bloco chamado "indicadoresFornecedor" e um campo "avaliacaoAutomaticaSaldo" gerados por REGRAS AUTOMÁTICAS determinísticas:

- "indicadoresFornecedor" contém, para cada relatório (balancete, contas_pagar, razao):
  - as linhas exatas em que o fornecedor aparece;
  - todos os valores monetários encontrados na linha;
  - o último valor monetário (normalmente o saldo).
- "avaliacaoAutomaticaSaldo" pode ter:
  - status "saldos_iguais" => os saldos numéricos dos relatórios são praticamente iguais;
  - status "saldos_diferentes" => foram encontrados saldos diferentes;
  - status "dados_insuficientes" => não foi possível comparar com segurança.

REGRAS MUITO IMPORTANTES (NÃO DESCUMPRIR):

1) Se "avaliacaoAutomaticaSaldo.status" for "saldos_iguais":
   - NÃO crie divergência do tipo "saldo_diferente".
   - Não diga que algum relatório está com saldo zerado se existe saldo identificado nos indicadores.
   - Deixe claro no "resumoExecutivo" que, em relação ao saldo, os relatórios estão CONSISTENTES para o fornecedor.

2) Se "avaliacaoAutomaticaSaldo.status" for "dados_insuficientes":
   - NÃO afirme que o saldo de algum relatório é zero só porque você não enxergou o valor na amostra.
   - Use frases como "não foi possível localizar o saldo na amostra do relatório de contas a pagar" em vez de declarar que o saldo é zerado.

3) Só considere que há "saldo_diferente" quando:
   - a avaliação automática indicar "saldos_diferentes" OU
   - você enxergar, nos próprios "indicadoresFornecedor", valores evidentemente divergentes entre os relatórios.
   Mesmo assim, deixe claro se a conclusão depende de amostras parciais.

4) Nunca invente NF, datas ou valores específicos que não estejam claramente visíveis nas amostras ou nos indicadores.

5) Sempre responda em PORTUGUÊS DO BRASIL.

Sua resposta DEVE SER SEMPRE um JSON VÁLIDO e NADA ALÉM DISSO (sem texto fora do JSON).

ESTRUTURA OBRIGATÓRIA DO JSON:

{
  "resumoExecutivo": "texto curto e direto sobre a situação do fornecedor",
  "composicaoSaldo": [
    {
      "fonte": "contas_pagar | balancete | razao | pagamentos | estimado",
      "descricao": "explicação da linha",
      "valorEstimado": 0,
      "observacoes": "se não der para afirmar com 100% de certeza, explique aqui"
    }
  ],
  "divergencias": [
    {
      "descricao": "explicação clara da divergência",
      "tipo": "saldo_diferente | titulo_pago_nao_baixado | titulo_sem_pagamento | fornecedor_sem_lancamento | outro",
      "referencias": ["ex: NF, data, conta contábil, fornecedor, banco etc."],
      "nivelCriticidade": "baixa | media | alta"
    }
  ],
  "pagamentosOrfaos": [
    {
      "descricao": "pagamento que aparece no extrato mas não aparece no contas a pagar ou razão",
      "valorEstimado": 0,
      "referencias": ["dados que ajudem a localizar no sistema"],
      "nivelRisco": "baixo | medio | alto"
    }
  ],
  "titulosVencidosSemContrapartida": [
    {
      "descricao": "título que aparece aberto mas sem pagamento correspondente",
      "valorEstimado": 0,
      "referencias": ["ex: NF, fornecedor, data de vencimento"],
      "diasEmAtrasoEstimado": 0
    }
  ],
  "passosRecomendados": [
    "passo 1 em linguagem simples",
    "passo 2",
    "passo 3"
  ],
  "observacoesGerais": "comentários adicionais ou limitações dos dados"
}
`;

  const userPrompt = `
Você recebeu um resumo dos relatórios do fornecedor "${fornecedor}", incluindo indicadores numéricos automáticos.

Use esses dados para montar um DIAGNÓSTICO DE CONCILIAÇÃO, apontando:
- composição de saldo,
- divergências,
- pagamentos órfãos,
- títulos vencidos sem contrapartida,
- próximos passos.

LEMBRE-SE:
- Respeite rigorosamente as regras sobre "avaliacaoAutomaticaSaldo" descritas na mensagem de sistema.
- Se os saldos forem considerados iguais pela avaliação automática, NÃO crie divergência de saldo.

DADOS DOS RELATÓRIOS E INDICADORES:
${JSON.stringify(entradaIA, null, 2)}
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const rawContent = completion.choices?.[0]?.message?.content?.trim() || "";

    let estruturaJson = null;
    try {
      estruturaJson = JSON.parse(rawContent);
    } catch (err) {
      console.warn(
        "[conciliacao.service] Falha ao fazer parse do JSON da IA. Devolvendo texto bruto.",
        err.message
      );
    }

    return {
      fornecedor,
      simulacao,
      status: estruturaJson ? "conciliacao_gerada" : "conciliacao_texto",
      modelo: "gpt-4.1-mini",
      entradaIA,
      estrutura: estruturaJson,
      respostaBruta: rawContent,
    };
  } catch (err) {
    console.error("[conciliacao.service] Erro na chamada OpenAI:", err.message);
    return {
      fornecedor,
      simulacao,
      status: "erro_openai",
      mensagem: "Falha ao gerar conciliação com IA. Veja logs no servidor.",
      detalhe: err.message,
    };
  }
}
