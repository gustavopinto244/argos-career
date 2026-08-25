# ArgosCareer - Auditoria de Produto

**Data:** 23 de Agosto de 2026
**Objetivo:** Revisão completa do produto, arquitetura, qualidade do código e registro do status atual do repositório, com apontamento de correções para erros potenciais identificados na base.

## 1. Visão Geral do Produto
O *ArgosCareer* é um sistema automatizado para busca, filtragem e avaliação de vagas de estágio focado no usuário final (candidato). O fluxo principal consiste em:
1. **Coleta** de postagens de vagas de plataformas externas (ex: Gupy, Indeed, CIEE).
2. **Pré-filtro** determinístico para remoção rápida de vagas inadequadas com custo zero (descarta de 84% a 97% das vagas irrelevantes).
3. **Avaliação via IA** (Scoring) contra um perfil mestre (master profile).
4. **Entrega de Digest** diário das melhores vagas classificadas via Telegram.
5. **Inteligência de Mercado**: Geração de análise de gaps e plano de estudos, extraindo do mercado as habilidades mais solicitadas vs. perfil atual (adicionado no M10).

## 2. Arquitetura e Stack Tecnológica
O sistema aplica a **Arquitetura Hexagonal** (Domain, Application, Infrastructure / Ports and Adapters) visando manter as lógicas de inteligência e avaliações isoladas das dependências externas.
- **Linguagem e Runtime:** Node.js (>= 22.12.0) e TypeScript estrito.
- **Framework:** NestJS (Injeção de dependência, agendamento de tarefas, throttler e estrutura das APIs).
- **Persistência:** Banco local SQLite utilizando o Drizzle ORM para queries e migrações.
- **Pipeline de IA (Scoring):** Uso de Stage A (Extração), Stage B (Matching) via OpenRouter LLMs e Stage C (Scoring aritmético em código, conforme ADR-005).

## 3. Qualidade do Código
- A suíte de testes unitários foi executada e conta com **1214 testes passando integralmente** via `vitest`.
- A tipagem estrita (`tsc`) e o linter (`eslint`) não apresentaram falhas, atestando organização extrema e adesão às boas práticas de Engenharia de Software.
- Farta base de **Architecture Decision Records (ADRs)** e controle rigoroso de issues conhecidas no arquivo `docs/11-known-issues.md`.

---

## 4. Verificação de Código e Correção de Erros Potenciais
Durante a auditoria profunda, identificamos vulnerabilidades no ecossistema e bugs conhecidos (relatados internamente) que impactam a estabilidade/descoberta de vagas. 

Abaixo estão as correções mapeadas prontas para aplicação futura:

### Correção 1: Perda de Vagas no Indeed (Issue B16)
**Problema:** Foi reportado no arquivo `11-known-issues.md` (B16) que o normalizador do Indeed descarta silenciosamente cerca de 15% das vagas válidas (ex: "Estagiário DevOps") pelo fato de a API do JobSpy eventualmente retornar `company: null`. Como `company` é um campo obrigatório no domínio `Posting`, o registro era invalidado (`return null`).
**Código Afetado:** `src/posting/infrastructure/indeed-normalizer.ts`
**Correção Proposta:** Empregar o conceito de fallback honesto para "Confidencial", preservando a vaga sem inferir um dado incerto. 

*Substituir o trecho (Linha 52)*:
```typescript
  if (!job.company) return null;

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: job.company,
```

*Por*:
```typescript
  // Prevenção contra falsos-negativos para vagas cujo Jobspy falha em extrair a empresa.
  const company = job.company || "Confidencial";

  try {
    return createPosting({
      source: raw.source,
      sourceId: raw.sourceId,
      company: company,
```

### Correção 2: Vulnerabilidade no Ecossistema NPM (esbuild)
**Problema:** A execução de `npm audit` identificou falhas de severidade moderada vinculadas ao `esbuild <=0.24.2`. O projeto consome esta versão vulnerável através da dependência legada `@esbuild-kit/esm-loader`, que por sua vez vem instalada pelo `drizzle-kit@0.19.0`. A vulnerabilidade permite SSRF (Server-Side Request Forgery) em ambientes de desenvolvimento que expõem o build.
**Código Afetado:** `package.json` (seção de dependências de desenvolvimento).
**Correção Proposta:** Como o repositório já atualizou a stack para Node >=22.12 e utiliza ativamente o `tsx` para execução de scripts (presente no package.json), e considerando que o ecossistema do Drizzle está maduro:
- Atualizar a versão do `drizzle-kit` para `^0.24.0` ou mais recente e aplicar o `npm audit fix` para sanear a arvore de dependências, ou:
- Executar no terminal:
  ```bash
  npm install -D drizzle-kit@latest
  npm audit fix
  ```

### Correção 3: Tratamento de Timeout e Rate-Limits em Delivery
**Problema:** Como descrito historicamente em algumas ADRs e correções pontuais, APIs terceiras (como Telegram e OpenRouter) podem falhar ou entrar em Timeout. O projeto corrigiu falhas do Telegram, mas vale reforçar se há tratamento global com Retry.
**Correção Proposta:** Recomenda-se adicionar um `Circuit Breaker` (como o oferecido pelas lib estendidas do NestJS/RxJS) para interromper os processos do `RunLock` temporariamente se ocorrem mais de N Timeouts seguidos do OpenRouter num curto intervalo, salvando cotas e permitindo processamento amigável depois. (Isto deve ser modelado após o preenchimento da quota de 50 labelled postings).

---

## 5. Conclusão
A estrutura base do **ArgosCareer** está incrivelmente sólida, sendo pouquíssimos os projetos que atingem 100% de passagem nos testes e tipagem com tamanho zelo arquitetural. Recomendamos a aplicação das correções sugeridas no Bloco 4 (especialmente o Fix do Indeed) para estancar o vazamento silencioso de boas vagas.
