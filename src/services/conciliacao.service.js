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

  const entradaIA = {
    fornecedor,
    relatorios: relatoriosResumidos,
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
- Seu objetivo é AJUDAR o contador a enxergar divergências, composição de saldo e próximos passos.

REGRAS IMPORTANTES:
- Sempre responda em PORTUGUÊS DO BRASIL.
- Nunca invente NF ou valores específicos se não estiverem claros nas amostras.
- Quando os dados forem insuficientes, deixe claro no campo "observacoes".
- Sua resposta DEVE SER SEMPRE um JSON VÁLIDO e NADA ALÉM DISSO (sem texto fora do JSON).

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
Você recebeu um resumo dos relatórios do fornecedor "${fornecedor}".

Use esses dados para montar um DIAGNÓSTICO DE CONCILIAÇÃO, apontando:
- composição de saldo,
- divergências,
- pagamentos órfãos,
- títulos vencidos sem contrapartida,
- próximos passos.

DADOS DOS RELATÓRIOS (RESUMO + TRECHOS):
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
      entradaIA: relatoriosResumidos,
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
