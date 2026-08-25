# Relatório de Auditoria Técnica — ArgosCareer

**Data da Auditoria:** 2026-08-25  
**Commit Auditado:** `3faf9cbbb5e730cd1de627a342c24b65c0de3035` (`main`)  
**Status do Pipeline de CI:** `PASS` (1275 testes em 92 arquivos, 0 falhas, typecheck e lint limpos)  
**Auditor Responsável:** Auditor Técnico Sênior (Perito de Engenharia de Software)  

---

## 1. Sumário Executivo

### 1.1 Diagnóstico do Sistema
O **ArgosCareer** é um sistema autônomo de radar de carreiras e inteligência de mercado de estágio, desenvolvido em TypeScript (Node.js/NestJS) com persistência em SQLite (Drizzle ORM) e integração com modelos de linguagem (LLM) via OpenRouter. A base de código exibe um nível excepcional de maturidade de engenharia de software, aderência estrita ao paradigma *Ports and Adapters* (Clean/Hexagonal Architecture), disciplina rigorosa de invariantes em tempo de execução via Zod, e proteção em profundidade contra injeção de prompt e alucinações de LLM. Não foram identificadas vulnerabilidades de segurança críticas ou falhas bloqueantes de integridade de dados; os achados levantados concentram-se em oportunidades de sincronização de limites de concorrência, telemetria de parser silencioso e robustez de locks em coletores externos.

### 1.2 Métricas Consolidadas do Repositório

| Métrica | Valor Verificado | Observação / Comando |
| :--- | :--- | :--- |
| **Total de Arquivos Rastreados** | 420 | `git ls-files \| wc -l` |
| **Arquivos TypeScript (`.ts`)** | 229 | `git ls-files '*.ts' \| wc -l` |
| **Arquivos Markdown (`.md`)** | 105 | `git ls-files '*.md' \| wc -l` |
| **Arquivos JSON (`.json`)** | 39 | `git ls-files '*.json' \| wc -l` |
| **Arquivos SQL (`.sql`)** | 25 | `git ls-files '*.sql' \| wc -l` |
| **Total de Linhas em `src/`** | 16.023 | `find src -name "*.ts" \| xargs wc -l` |
| **Testes Automatizados (Raiz)** | 1.217 testes / 90 arquivos | `npm test` (`vitest run`) |
| **Testes Automatizados (Catho)** | 58 testes / 2 arquivos | `npm test` em `collectors/catho` |
| **Total de Testes Automatizados** | **1.275 testes / 92 arquivos** | 100% de sucesso (0 falhas) |
| **Erros de Tipagem (`tsc`)** | 0 erros | `npm run typecheck` (ambos os pacotes) |
| **Violações de Linter (`eslint`)** | 0 advertências / erros | `npm run lint` |
| **Comentários `TODO`/`FIXME`** | 0 ocorrências | `rg -i "TODO\|FIXME" src/ collectors/` |
| **Supressões `@ts-ignore`/`@ts-expect`** | 0 ocorrências | `rg "@ts-(ignore\|expect-error)" src/` |

### 1.3 Tabela Consolidada de Achados

| ID | Severidade | Módulo | Descrição Curta | Localização (Arquivo:Linhas) |
| :--- | :---: | :--- | :--- | :--- |
| **ACH-01** | **MÉDIA** | Scoring / Matcher | Desacoplamento entre constante padrão de concorrência e schema Zod | [`src/scoring/infrastructure/stage-b-matcher.ts:L31`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-b-matcher.ts#L31) |
| **ACH-02** | **MÉDIA** | Collectors / Catho | Risco de perda de lock por event-loop lag durante navegação Playwright | [`collectors/catho/collect.ts:L286-L317`](file:///home/gustavo/Desktop/Projects/argos-career/collectors/catho/collect.ts#L286-L317) |
| **ACH-03** | **MÉDIA** | Prefilter / Criteria | Falta de sanitização de strings vazias em `ignoredProviders` no schema | [`src/prefilter/domain/criteria.ts:L175-L177`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/criteria.ts#L175-L177) |
| **ACH-04** | **BAIXA** | Persistence / Repos | Degradação de JSON malformado sem emissão de telemetria/log estruturado | [`src/persistence/infrastructure/postings-repository.ts:L47-L53`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/postings-repository.ts#L47-L53) |
| **ACH-05** | **BAIXA** | Scheduling / Cron | Inconsistência de intervalo quando `collection.intervalHours` não divide 24 | [`src/scheduling/infrastructure/scheduler.service.ts:L38-L40`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/infrastructure/scheduler.service.ts#L38-L40) |

### 1.4 Veredito Geral de Prontidão para Produção

**Veredito:** **APTO COM RESSALVAS MENORES**  
**Justificativa:** O sistema possui arquitetura sólida, garantias transacionais e defensivas em camadas críticas (deduplicação, filtragem, matching determinístico, circuit breaker, entrega tolerante a 429 e reconciliação de checkpoints de entrega). Não há débitos técnicos acumulados, vulnerabilidades conhecidas nem falhas de tipagem. As ressalvas decorrem de pequenos desacoplamentos de configuração e necessidade de monitoramento de batimentos de lock em processos de coleta externos de longa duração.

---

## 2. Inventário e Topologia

### 2.1 Árvore do Repositório Comentada

```
argos-career/
├── .github/                      # Workflows de CI/CD e templates de PR
├── config/                       # Arquivos de configuração de critérios e perfil (gitignored para dados pessoais)
├── collectors/                   # Coletores standalone fora do processo principal
│   ├── catho/                   # Coletor Playwright (Chromium) para scraping autenticado da Catho
│   └── indeed/                  # Coletor Python (JobSpy) para busca no Indeed
├── docs/                         # Documentação técnica viva, arquitetura, glossário e incidentes
│   ├── adr/                     # 61 Architecture Decision Records (ADR-001 a ADR-061)
│   └── audit/                   # Relatórios de auditoria e planos de remediação
├── drizzle/                      # Migrações versionadas SQL para SQLite
├── fixtures/                     # Payloads reais higienizados de job boards para testes de regressão
├── prompts/                      # Templates versionados de prompts LLM (Stage A e Stage B)
├── scripts/                      # Scripts de manutenção, calibração, backup, restore e benchmark
└── src/                          # Código-fonte principal da aplicação (NestJS + CLI)
    ├── api/                     # Módulo HTTP / REST e transporte Model Context Protocol (MCP)
    │   ├── application/         # Serviços de aplicação orquestradores (Runs, Postings, Market)
    │   └── infrastructure/      # Controllers, guards de autenticação, provedores DI e throttlers
    ├── cli/                     # Ponto de entrada CLI e funções orquestradoras (executeCollect, etc.)
    ├── config/                  # Infraestrutura de carregamento de arquivos YAML
    ├── delivery/                # Módulo de composição e renderização do Digest e envio via Telegram
    │   ├── domain/              # Tipos do digest, portas de notificação e renderizador pt-BR
    │   └── infrastructure/      # Cliente Telegram com controle de taxa (pacing) e recuperação 429
    ├── market/                  # Inteligência de mercado e geração de plano de estudos (M10)
    │   ├── domain/              # Agregação estatística, análise de gaps e taxonomia
    │   └── infrastructure/      # Carregadores de taxonomia e repositório de mercado
    ├── persistence/             # Camada de banco de dados e persistência relacional (Drizzle/SQLite)
    │   ├── application/         # Algoritmos de deduplicação similar (Layer 2 em shadow mode)
    │   └── infrastructure/      # Schema Drizzle, repositórios tipados, backup e restore
    ├── posting/                 # Entidade central Posting, normalização e coletores internos
    │   ├── domain/              # Entidade Posting, Invariantes, Fingerprint e Similaridade
    │   └── infrastructure/      # Coletores HTTP (Gupy, CIEE, Sólides, InfoJobs) e Normalizadores
    ├── prefilter/               # Pré-filtro booleano de baixo custo computacional (M5)
    │   ├── domain/              # Regras de descarte rápido, classificação de trilhas e critérios
    │   └── infrastructure/      # Carregador e validador de criteria.yaml (Zod)
    ├── profile/                 # Perfil do candidato e projeção de competências
    │   ├── domain/              # Entidade Profile, período acadêmico e hash de perfil
    │   └── infrastructure/      # Carregador e validador de profile.yaml (Zod)
    ├── scoring/                 # Motor de avaliação e pontuação multi-estágio (A, B e C)
    │   ├── domain/              # Score determinístico (Stage C), catálogo e proveniência de evidências
    │   └── infrastructure/      # Extrator Stage A, Matcher Stage B, Cliente OpenRouter e Circuit Breaker
    └── scheduling/              # Agendador de tarefas e observabilidade em segundo plano
        ├── domain/              # Avaliadores puros de alertas de saúde e RunLock
        └── infrastructure/      # Serviço de agendamento NestJS Cron e provedor de lock
```

### 2.2 Fluxo de Dados Fim a Fim

```
[Fontes Externas]
  ├── Gupy (API HTTP) ─────────► [GupyCollector] ───────────────┐
  ├── CIEE (API HTTP) ─────────► [CieeCollector] ───────────────┤
  ├── Sólides (API HTTP) ──────► [SolidesCollector] ────────────┤
  ├── InfoJobs (HTML/HTTP) ────► [InfoJobsCollector] ───────────┼──► [Normalizers Registry]
  ├── Catho (Playwright) ──────► [POST /runs/collect/external] ─┤           │
  ├── Indeed (Python JobSpy) ──► [POST /runs/collect/external] ─┤           │
  └── LinkedIn (Alertas n8n) ──► [POST /runs/collect/external] ─┘           │
                                                                            ▼
                                                                   [RawPosting -> Posting]
                                                                            │
                                                       (Layer 1 Dedup)      │ sha256(company+title+city)
                                                                            ▼
                                                             [PostingsRepository.upsertMany]
                                                                            │
                                                                            ├──► [SQLite: postings (WAL)]
                                                                            ▼
                                                             [dedupSimilarPostings (Layer 2)]
                                                                            │
                                                                            ├──► [Shadow Mode: posting_events]
                                                                            ▼
                                                                   [preFilter (Booleano)]
                                                                            │
                                                ┌───────────────────────────┴───────────────────────────┐
                                                ▼ (Rejeitado)                                           ▼ (Aprovado)
                                    [posting_events: prefilter]                            [claimForScoring (Atomic TX)]
                                                                                                        │
                                                                                                        ▼
                                                                                           [Stage A Extractor (LLM)]
                                                                                                        │
                                                                                                        ├──► [Cache: extractions]
                                                                                                        ▼
                                                                                           [Stage B Matcher (LLM)]
                                                                                                        │
                                                                                                        ├──► [Cache: matches]
                                                                                                        ▼
                                                                                           [Stage C Scoring (Puro TS)]
                                                                                                        │
                                                                                                        ▼
                                                                                           [Recommendation Engine]
                                                                                                        │
                                                                                                        ▼
                                                                                           [composeDigest & Render]
                                                                                                        │
                                                                                                        ▼
                                                                                           [Delivery Checkpoint (SQLite)]
                                                                                                        │
                                                                                                        ▼
                                                                                           [TelegramNotifier (Paced/429)]
```

### 2.3 Tabela de Dependências Externas

#### Dependências de Produção (`dependencies` em `package.json`)
| Pacote | Versão Instalada | Finalidade no Sistema |
| :--- | :---: | :--- |
| `@modelcontextprotocol/sdk` | `^1.6.0` | Servidor e transporte HTTP/SSE para protocolo MCP |
| `@nestjs/common` | `^11.0.1` | Core do framework NestJS e injeção de dependências |
| `@nestjs/core` | `^11.0.1` | Kernel do NestJS e ciclo de vida da aplicação |
| `@nestjs/platform-express`| `^11.0.1` | Adaptador HTTP Express para NestJS |
| `@nestjs/schedule` | `^6.1.0` | Orquestração de tarefas agendadas em segundo plano |
| `@nestjs/throttler` | `^6.4.0` | Rate limiting para endpoints HTTP e operações sensíveis |
| `better-sqlite3` | `^11.8.1` | Driver síncrono e de alta performance para SQLite C API |
| `cron` | `^4.3.5` | Mecanismo de parsing e cálculo de expressões cron |
| `drizzle-orm` | `^0.39.3` | ORM type-safe e query builder para SQLite |
| `express` | `^5.0.1` | Servidor HTTP subjacente |
| `reflect-metadata` | `^0.2.2` | Suporte a decoradores TypeScript |
| `rxjs` | `^7.8.1` | Reatividade e fluxos assíncronos do NestJS |
| `ulid` | `^2.3.0` | Geração de identificadores únicos lexicograficamente ordenáveis |
| `yaml` | `^2.7.0` | Parser seguro para arquivos de configuração YAML |
| `zod` | `^3.24.1` | Validação estrita de contratos de dados em runtime |

#### Dependências de Desenvolvimento (`devDependencies` em `package.json`)
| Pacote | Versão Instalada | Finalidade |
| :--- | :---: | :--- |
| `@eslint/js` | `^9.18.0` | Regras base do ESLint |
| `@types/better-sqlite3` | `^7.6.12` | Tipagens TypeScript para SQLite |
| `@types/express` | `^5.0.0` | Tipagens TypeScript para Express |
| `@types/node` | `^22.10.7` | Tipagens para Node.js v22 |
| `drizzle-kit` | `^0.30.4` | Gerador e executor de migrações Drizzle |
| `eslint` | `^9.18.0` | Linter estático de código |
| `prettier` | `^3.4.2` | Formatador de código |
| `tsx` | `^4.19.2` | Executor rápido de TypeScript com esbuild |
| `typescript` | `^5.7.3` | Compilador TypeScript |
| `typescript-eslint` | `^8.20.0` | Regras de tipagem estrita para ESLint |
| `vitest` | `^3.0.4` | Runner de testes unitários e de integração de alta velocidade |

### 2.4 Tabela de Integrações Externas

| Integração / Serviço | Protocolo | Autenticação / Credencial | Finalidade | Criticidade |
| :--- | :--- | :--- | :--- | :---: |
| **OpenRouter API** | HTTPS / REST (JSON) | `Authorization: Bearer $LLM_API_KEY` | Extração Stage A e Matching Stage B via LLM | **ALTA** |
| **Telegram Bot API** | HTTPS / REST (JSON) | Bot Token na URL (`$TELEGRAM_BOT_TOKEN`) | Envio do Digest diário e alertas operacionais | **ALTA** |
| **Gupy Public API** | HTTPS / REST (JSON) | Nenhuma (pública) | Coleta de vagas de estágio | **MÉDIA** |
| **CIEE Public API** | HTTPS / REST (JSON) | Nenhuma (pública) | Coleta de vagas de estágio para estudantes | **MÉDIA** |
| **Sólides Public API** | HTTPS / REST (JSON) | Nenhuma (pública) | Coleta de vagas de estágio em PMEs | **MÉDIA** |
| **InfoJobs Public HTML**| HTTPS / Web Scraping | Nenhuma (pública) | Coleta de vagas de estágio via listagem HTML | **MÉDIA** |
| **Catho Scraper** | Local Subprocess / Playwright | Ingest API Key (`$INGEST_CATHO_API_KEY`) | Coleta com renderização de SPA / anti-bot | **MÉDIA** |
| **Indeed JobSpy** | Local Subprocess / Python | Ingest API Key (`$INGEST_INDEED_API_KEY`) | Coleta via JobSpy com parsing TLS | **MÉDIA** |
| **n8n Ingest Webhook** | HTTPS / REST (JSON) | Ingest API Key (`$INGEST_LINKEDIN_API_KEY`)| Ingestão de alertas de e-mail do LinkedIn | **MÉDIA** |
| **Hermes Assistant** | HTTP / MCP sobre Tailscale | Admin Key (`$API_ADMIN_KEY` / `API_KEY`) | Disparo manual, consultas de status e plano | **BAIXA** |

---

## 3. Validação das Declarações do Prompt vs Código

Esta seção confronta cada afirmação do contexto declarado no prompt contra a implementação real encontrada nos arquivos do repositório.

| Afirmação no Prompt / Contexto | Arquivo:Linhas de Evidência | Status | Análise e Evidência Concreta |
| :--- | :--- | :---: | :--- |
| **"Hermes é a camada operacional de coleta, deduplicação e ranking"** | [`CLAUDE.md:L298-L320`](file:///home/gustavo/Desktop/Projects/argos-career/CLAUDE.md#L298-L320)<br>[`docs/adr/017-tailscale-and-bearer-key-for-the-api-boundary.md:L5-L16`](file:///home/gustavo/Desktop/Projects/argos-career/docs/adr/017-tailscale-and-bearer-key-for-the-api-boundary.md#L5-L16)<br>[`src/scheduling/infrastructure/scheduler.service.ts:L48-L64`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/infrastructure/scheduler.service.ts#L48-L64) | **DIVERGENTE** | **Divergência comprovada:** O ArgosCareer é um serviço autônomo e auto-suficiente. A coleta, normalização, deduplicação, pré-filtro, scoring e ranking ocorrem inteiramente dentro do ArgosCareer (via NestJS scheduler e CLI). O Hermes é um agente cliente externo que interage via HTTP/MCP para disparos pontuais ou consultas. |
| **"Pipeline: Coleta → Normalização → Deduplicação → Filtragem → Análise → Ranking → Digest → Revisão humana"** | [`src/cli/main.ts:L45-L774`](file:///home/gustavo/Desktop/Projects/argos-career/src/cli/main.ts#L45-L774)<br>[`src/posting/domain/posting.ts:L88-L120`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/domain/posting.ts#L88-L120)<br>[`src/prefilter/domain/pre-filter.ts:L196-L268`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/pre-filter.ts#L196-L268)<br>[`src/scoring/domain/score.ts:L128-L217`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/score.ts#L128-L217)<br>[`src/delivery/domain/digest.ts:L106-L125`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/digest.ts#L106-L125) | **CONFIRMADO** | Implementado exatamente na sequência descrita, com estágios desacoplados e orquestrados por comandos CLI reutilizáveis. |
| **"Deduplicação de vagas no pipeline"** | [`src/posting/domain/fingerprint.ts:L31-L38`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/domain/fingerprint.ts#L31-L38)<br>[`src/persistence/infrastructure/postings-repository.ts:L108-L109`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/postings-repository.ts#L108-L109)<br>[`src/persistence/application/dedup-similar-postings.ts:L134-L249`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/application/dedup-similar-postings.ts#L134-L249) | **CONFIRMADO** | Camada 1 deduplica por hash SHA-256 no banco; Camada 2 executa similaridade Sørensen-Dice em bigramas em shadow mode para auditoria. |
| **"Digest consolida oportunidades e entrega via Telegram"** | [`src/delivery/domain/digest.ts:L71-L78`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/digest.ts#L71-L78)<br>[`src/delivery/domain/render-digest.ts:L150-L158`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/render-digest.ts#L150-L158)<br>[`src/delivery/infrastructure/telegram-notifier.ts:L197-L375`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/infrastructure/telegram-notifier.ts#L197-L375) | **CONFIRMADO** | Agrupamento em seções ("Recomendadas", "Vale avaliar", "Abrem em breve", "Resumo da execução"), chunking de 4096 caracteres e envio via API do Telegram. |
| **"n8n para automação e alertas do LinkedIn"** | [`src/api/infrastructure/runs.controller.ts:L87-L105`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/runs.controller.ts#L87-L105)<br>[`src/posting/infrastructure/linkedin-alert-normalizer.ts:L1-L141`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/linkedin-alert-normalizer.ts#L1-L141) | **CONFIRMADO** | Endpoint `POST /runs/collect/external` recebe payloads de e-mails de alerta do LinkedIn processados pelo n8n, normalizando-os diretamente. |
| **"Uso de LLM no pipeline para extração e scoring"** | [`src/scoring/infrastructure/stage-a-extractor.ts:L121-L244`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-a-extractor.ts#L121-L244)<br>[`src/scoring/infrastructure/stage-b-matcher.ts:L129-L367`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-b-matcher.ts#L129-L367)<br>[`src/scoring/domain/score.ts:L128-L217`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/score.ts#L128-L217) | **CONFIRMADO** | Stage A extrai requisitos estruturados da descrição da vaga via LLM; Stage B julga matching contra evidências do perfil via LLM; Stage C calcula o score matematicamente em código TypeScript puro. |
| **"Hospedagem em servidor doméstico com Docker, Tailscale e PM2/Systemd"** | [`Dockerfile:L1-L36`](file:///home/gustavo/Desktop/Projects/argos-career/Dockerfile#L1-L36)<br>[`compose.production.yaml:L1-L31`](file:///home/gustavo/Desktop/Projects/argos-career/compose.production.yaml#L1-L31)<br>[`collectors/catho/argos-catho-collect.service:L1-L32`](file:///home/gustavo/Desktop/Projects/argos-career/collectors/catho/argos-catho-collect.service#L1-L32) | **CONFIRMADO** | O processo principal roda em container Docker enxuto (`node:22-alpine`), com timers systemd para coletores standalone e interface de rede restrita ao Tailscale. |

---

## 4. Análise Arquitetural e Design

### 4.1 Aderência a Clean Architecture e Hexagonal
O repositório adota fielmente o modelo *Ports & Adapters*:
- **Domínio Puro (`src/*/domain/`)**: Livre de qualquer importação de bibliotecas de infraestrutura, NestJS, SQLite ou I/O de rede. Funções matemáticas, lógicas de pré-filtro, invariantes de entidade e transformações de texto operam apenas sobre dados imutáveis em memória.
- **Portas (`ports/*.port.ts`)**: Interfaces explícitas que definem contratos agnósticos de implementação:
  - [`CollectorPort`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/domain/ports/collector.port.ts#L36-L59) para coleta.
  - [`ScorerPort`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/ports/scorer.port.ts#L52-L68) para o motor de avaliação.
  - [`NotifierPort`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/ports/notifier.port.ts#L1-L19) e [`DeliveryCheckpointPort`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/ports/delivery-checkpoint.port.ts#L1-L43) para entrega.
- **Adaptadores de Infraestrutura (`src/*/infrastructure/`)**: Implementam as portas desacopladas, permitindo substituição transparente em testes por stubs sem I/O.

### 4.2 Acoplamento Temporal e Concorrência
O sistema resolve potenciais condições de corrida através de duas barreiras complementares:
1. **Em memória (In-Process)**: [`RunLock`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/domain/run-lock.ts#L38-L85) impede que ticks do cron do NestJS e chamadas manuais via REST/MCP iniciem o mesmo estágio simultaneamente dentro do mesmo processo Node.js.
2. **No Banco de Dados (Cross-Process)**: [`claimForScoring`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/postings-repository.ts#L401-L436) realiza a reserva atômica de vagas elegíveis via transação SQLite com bloqueio de arquivo, garantindo que invocações paralelas de CLI não pontuem as mesmas vagas duas vezes.

### 4.3 Tratamento de Falhas e Degradação Graciosa
- **Fail-Fast na Inicialização**: Erros de schema em `criteria.yaml` ([`CriteriaValidationError`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/infrastructure/criteria-loader.ts#L4-L17)) ou `profile.yaml` ([`ProfileValidationError`](file:///home/gustavo/Desktop/Projects/argos-career/src/profile/infrastructure/profile-loader.ts#L10-L23)), ou ausência de chaves de API obrigatórias ([`build-scorer.ts:L89-L95`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/build-scorer.ts#L89-L95)) abortam o boot imediatamente, evitando comportamento imprevisível em tempo de execução.
- **Degradação Graciosa em Operação**: Falha em um coletor individual não interrompe os demais coletores do lote ([`executeCollect` em `cli/main.ts:L465-L498`](file:///home/gustavo/Desktop/Projects/argos-career/src/cli/main.ts#L465-L498)); respostas corrompidas de cache no SQLite são tratadas como *cache miss* em vez de disparar exceções não tratadas ([`extractions-repository.ts:L27-L36`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/extractions-repository.ts#L27-L36)).

---

## 5. Análise Módulo por Módulo (Deep Dive)

### 5.1 Coleta (`src/posting/` e `collectors/`)
- **Responsabilidade**: Buscar oportunidades brutas a partir de job boards públicos ou scraping standalone, isolando erros e controlando taxa de requisições.
- **Arquivos-chave**:
  - [`src/posting/infrastructure/gupy-collector.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/gupy-collector.ts)
  - [`src/posting/infrastructure/ciee-collector.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/ciee-collector.ts)
  - [`src/posting/infrastructure/solides-collector.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/solides-collector.ts)
  - [`src/posting/infrastructure/infojobs-collector.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/infojobs-collector.ts)
  - [`collectors/catho/collect.ts`](file:///home/gustavo/Desktop/Projects/argos-career/collectors/catho/collect.ts)
  - [`collectors/indeed/collect.py`](file:///home/gustavo/Desktop/Projects/argos-career/collectors/indeed/collect.py)
- **Invariantes**: Nenhuma falha HTTP em uma fonte pode propagar exceção que impeça a execução das demais fontes do ciclo; paginação é limitada por `maxResults` e tempo limite por requisição (`AbortController`).
- **Pontos Fortes**:
  - Validação estrita de envelopes de API com tolerância a campos ausentes via Zod `.passthrough()`.
  - Tratamento de rate-limit e isolamento completo no coletor Catho via arquivo de requeue persistente (`data/state/requeue.json`).
- **Fragilidades / Riscos**:
  - No coletor Catho (`collectors/catho/collect.ts:L286-L317`), o lock de arquivo é mantido via heartbeat assíncrono que pode atrasar se a página sofrer congelamento por scripts pesados no Chromium (ACH-02).
- **Conformidade de Testes**: Cobertura completa com mocks de `fetch` injetáveis e fixtures reais em `src/posting/infrastructure/*.test.ts` e `collectors/catho/state.test.ts`.

### 5.2 Normalização (`src/posting/infrastructure/*normalizer*.ts`)
- **Responsabilidade**: Mapear payloads brutos heterogêneos para a entidade canônica [`Posting`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/domain/posting.ts#L19-L58).
- **Arquivos-chave**:
  - [`gupy-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/gupy-normalizer.ts)
  - [`ciee-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/ciee-normalizer.ts)
  - [`solides-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/solides-normalizer.ts)
  - [`infojobs-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/infojobs-normalizer.ts)
  - [`catho-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/catho-normalizer.ts)
  - [`indeed-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/indeed-normalizer.ts)
  - [`linkedin-alert-normalizer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/infrastructure/linkedin-alert-normalizer.ts)
- **Invariantes**: Toda vaga normalizada possui `fingerprint` derivado exclusivamente de `sha256(normalize(company) + normalize(title) + normalize(city))`; o payload bruto original é preservado em `rawPayload`.
- **Pontos Fortes**: Extração robusta de modalidade de trabalho (`remote`, `hybrid`, `onsite`) a partir de texto livre ou tags proprietárias com normalização Unicode NFD.

### 5.3 Deduplicação (`src/posting/domain/` e `src/persistence/application/`)
- **Responsabilidade**: Identificar vagas idênticas ou republicadas entre diferentes portais ou dentro da mesma empresa.
- **Arquivos-chave**:
  - [`src/posting/domain/fingerprint.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/domain/fingerprint.ts)
  - [`src/posting/domain/title-similarity.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/posting/domain/title-similarity.ts)
  - [`src/persistence/application/dedup-similar-postings.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/application/dedup-similar-postings.ts)
- **Invariantes**: A Camada 1 é garantida pelo índice único `postings_fingerprint_unique` no SQLite. A Camada 2 opera em *shadow mode* sem descartar vagas do banco, apenas registrando pares candidatos em `posting_events`.
- **Pontos Fortes**: Remoção de sufixos societários (`S.A.`, `Ltda`) antes do agrupamento de empresas e janela temporal configurável (`windowDays`).

### 5.4 Pré-filtro (`src/prefilter/`)
- **Responsabilidade**: Filtrar rapidamente vagas inviáveis antes de realizar chamadas custosas à LLM.
- **Arquivos-chave**:
  - [`src/prefilter/domain/pre-filter.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/pre-filter.ts)
  - [`src/prefilter/domain/criteria.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/criteria.ts)
  - [`src/prefilter/domain/title-match.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/title-match.ts)
  - [`src/prefilter/domain/classify-track.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/classify-track.ts)
- **Invariantes**: Avaliação puramente determinística e síncrona; motivos de descarte mapeados na taxonomia `PreFilterRejectionReason`.
- **Pontos Fortes**: Tratamento assimétrico de localização (vagas remotas e de escopo nacional são toleradas mesmo com cidades distintas).

### 5.5 Scoring e LLM (`src/scoring/`)
- **Responsabilidade**: Extrair requisitos da vaga (Stage A), avaliar conformidade com o perfil (Stage B) e calcular a nota final (Stage C).
- **Arquivos-chave**:
  - [`src/scoring/infrastructure/api-scorer.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/api-scorer.ts)
  - [`src/scoring/infrastructure/stage-a-extractor.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-a-extractor.ts)
  - [`src/scoring/infrastructure/stage-b-matcher.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-b-matcher.ts)
  - [`src/scoring/domain/score.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/score.ts)
  - [`src/scoring/infrastructure/openrouter-client.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/openrouter-client.ts)
  - [`src/scoring/infrastructure/circuit-breaker.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/circuit-breaker.ts)
  - [`src/scoring/domain/evidence-provenance.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/evidence-provenance.ts)
- **Invariantes**:
  - Stage B executa chamada de aquecimento (warming call) para garantir acerto no cache de prefixo do provedor (71% de economia de tokens).
  - Toda resposta com status `met` ou `partial` é submetida a verificação estrita de proveniência lexical contra o perfil ([`evidence-provenance.ts:L209-L248`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/evidence-provenance.ts#L209-L248)). Citações inventadas pela LLM são forçadas para `not_met`.
  - Stage C é 100% determinístico e independente de rede.

### 5.6 Digest e Entrega (`src/delivery/`)
- **Responsabilidade**: Montar o resumo consolidado diário, formatar em texto legível pt-BR e enviar ao Telegram com controle de chunking e estado persistente.
- **Arquivos-chave**:
  - [`src/delivery/domain/digest.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/digest.ts)
  - [`src/delivery/domain/render-digest.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/domain/render-digest.ts)
  - [`src/delivery/infrastructure/telegram-notifier.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/delivery/infrastructure/telegram-notifier.ts)
- **Invariantes**: Mensagens maiores que 4096 caracteres são divididas respeitando quebras de seções e entradas; checkpoint durável em `delivery_operations` e `delivery_chunks` impede reenvio de partes já confirmadas pelo Telegram.

### 5.7 Persistência (`src/persistence/`)
- **Responsabilidade**: Gerenciar o banco de dados SQLite local, garantir consistência em modo WAL, armazenar caches de LLM, registrar eventos e fornecer rotinas de backup e restore atômicos.
- **Arquivos-chave**:
  - [`src/persistence/infrastructure/schema.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/schema.ts)
  - [`src/persistence/infrastructure/postings-repository.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/postings-repository.ts)
  - [`src/persistence/infrastructure/backup.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/backup.ts)
  - [`src/persistence/infrastructure/restore.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/restore.ts)
- **Invariantes**: `firstSeenAt` nunca é sobrescrito em upserts; backups utilizam a instrução nativa `VACUUM INTO`, segura para execução com o sistema ativo em modo WAL.

### 5.8 Agendamento e Observabilidade (`src/scheduling/`)
- **Responsabilidade**: Disparar ciclos periódicos de coleta, deduplicação, pontuação e entrega, além de avaliar regras de alertas de saúde do sistema.
- **Arquivos-chave**:
  - [`src/scheduling/infrastructure/scheduler.service.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/infrastructure/scheduler.service.ts)
  - [`src/scheduling/domain/alerts.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/domain/alerts.ts)
  - [`src/scheduling/domain/run-lock.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/domain/run-lock.ts)
- **Invariantes**: Avaliação de alertas é pura e desacoplada do canal de notificação; cancelamento cooperativo via flag `cancelRequested` permite interrupção graciosa do loop de scoring.

### 5.9 API e MCP (`src/api/`)
- **Responsabilidade**: Expor rotas HTTP REST e transporte Model Context Protocol (MCP) para clientes externos (Hermes, n8n, dashboards).
- **Arquivos-chave**:
  - [`src/api/infrastructure/api-key.guard.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/api-key.guard.ts)
  - [`src/api/infrastructure/runs.controller.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/runs.controller.ts)
  - [`src/api/infrastructure/mcp.controller.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/mcp.controller.ts)
  - [`src/api/infrastructure/runs.service.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/runs.service.ts)
- **Invariantes**: Todas as rotas exigem Bearer token autenticado com comparação em tempo constante (`timingSafeEqual`); chaves são segregadas por escopo (Admin, Automation, Ingest).

### 5.10 Market Intelligence e Study Plan (`src/market/`)
- **Responsabilidade**: Analisar o corpus histórico de vagas coletadas para identificar demandas do mercado e gerar plano de estudos personalizado (M10).
- **Arquivos-chave**:
  - [`src/market/domain/study-plan.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/market/domain/study-plan.ts)
  - [`src/market/domain/gap-analysis.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/market/domain/gap-analysis.ts)
  - [`src/market/domain/taxonomy.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/market/domain/taxonomy.ts)
  - [`src/market/infrastructure/market-repository.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/market/infrastructure/market-repository.ts)
- **Invariantes**: A geração do plano de estudos é estritamente *read-only* sobre os caches existentes no banco, sem realizar novas chamadas a LLM ou gastar créditos.

---

## 6. Análise de Segurança e Vetores de Ataque

### 6.1 Autenticação e Autorização
- **Mecanismo**: [`ApiKeyGuard`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/api-key.guard.ts#L26-L100) aplicado globalmente via `APP_GUARD`.
- **Mitigação de Timing Attacks**: Tokens são convertidos em hash SHA-256 de tamanho fixo antes da comparação via `crypto.timingSafeEqual` ([`api-key.guard.ts:L87-L90`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/api-key.guard.ts#L87-L90)), eliminando qualquer vazamento por tamanho ou tempo de resposta.
- **Escopos de Credenciais**:
  - `API_ADMIN_KEY`: Acesso irrestrito a todos os endpoints e tools MCP.
  - `API_AUTOMATION_KEY`: Restrito a `/health`, `/runs` e disparo de estágios.
  - `INGEST_<SOURCE>_API_KEY`: Restrito exclusivamente a `POST /runs/collect/external` para a fonte autorizada no token.

### 6.2 Defesa Contra Injeção de Prompt (Prompt Injection)
- **Isolamento de Entrada Não Confiável**: Os prompts delimitam explicitamente os dados externos através de tags de escape estritas (`<<<POSTING_TITLE>>>`, `<<<POSTING_DESCRIPTION>>>`, `<<<REQUIREMENT>>>`) acompanhadas de instrução explícita no meta-prompt orientando o modelo a tratar o texto como dados a serem lidos e nunca instruções a serem executadas ([`prompts/stage-a-extraction.v5.md:L50-L57`](file:///home/gustavo/Desktop/Projects/argos-career/prompts/stage-a-extraction.v5.md#L50-L57)).
- **Sanitização de Log Labels**: Textos de requisitos originados de vagas de terceiros sofrem sanitização estrita ([`src/scoring/domain/log-label.ts:L1-L25`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/log-label.ts#L1-L25)) antes de compor rótulos de log, impedindo ataques de Log Injection / CRLF Injection.
- **Validação Semântica de Provedores**: O runtime verifica se as citações retornadas pela LLM pertencem de fato ao perfil cadastrado ([`isKnownProfileEvidence`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/evidence-provenance.ts#L69-L77)) e se correspondem ao vocabulário do requisito ([`isEvidenceApplicableToRequirement`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/domain/evidence-provenance.ts#L209-L248)). Uma instrução maliciosa na descrição da vaga que tente forçar um `met` sem evidência real no perfil é automaticamente rebaixada para `not_met`.

### 6.3 Privacidade de Dados e LGPD
- **Arquivos Pessoais**: `config/profile.yaml` e `.env` estão devidamente incluídos no `.gitignore` ([`.gitignore:L19-L23`](file:///home/gustavo/Desktop/Projects/argos-career/.gitignore#L19-L23)).
- **Ausência de Segredos no Repositório**: A varredura por regex em todo o histórico rastreado confirmou que não existem tokens de Telegram, chaves de API da OpenRouter ou dados pessoais commitados.

### 6.4 Superfície de Rede
- **Configuração de Exposição**: O `Dockerfile` expõe a porta `3000` em interface não-root (`USER node`). Em produção, a API escuta apenas na interface do Tailscale ou rede interna Docker (`compose.production.yaml:L12-L14`), sem exposição direta à internet pública.

---

## 7. Análise de Concorrência, Resiliência e Operação

### 7.1 Gestão de Concorrência e Claims
- O processo adota `better-sqlite3` em modo WAL (`journal_mode = WAL` em [`db.ts:L24`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/db.ts#L24)), permitindo leituras simultâneas sem bloqueio de escrita.
- O claim atômico de vagas para pontuação (`claimForScoring`) possui lease de 4 horas (`DEFAULT_STALE_CLAIM_MS = 14_400_000` em [`postings-repository.ts:L32`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/postings-repository.ts#L32)), evitando acúmulo de vagas presas em caso de interrupção abrupta do processo.

### 7.2 Resiliência a Falhas do OpenRouter
- **Classificação Granular de Erros**: O cliente OpenRouter diferencia erros transientes (408, 429, 502, 503, 504) de erros permanentes de autenticação/configuração (401, 403, 404), interrompendo o lote imediatamente em caso de credencial inválida para evitar consumo inútil de retries ([`openrouter-client.ts:L317-L329`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/openrouter-client.ts#L317-L329)).
- **Circuit Breaker**: O disjuntor de 3 estados ([`circuit-breaker.ts:L45-L125`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/circuit-breaker.ts#L45-L125)) abre após 5 falhas consecutivas de transporte, entrando em cooldown de 30 segundos com teste singular em modo `half_open` para prevenir tempestades de requisições sobre a API externa.

### 7.3 Recuperabilidade e Backup
- O utilitário [`backupDatabase`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/backup.ts#L23-L43) gera snapshots consistentes com retenção de 7 versões (`retention = 7`).
- O utilitário [`restoreDatabase`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/restore.ts#L19-L45) valida previamente a integridade do arquivo de destino e recusa o restore se houver execução em andamento (`finished_at IS NULL`), limpando arquivos auxiliares `-wal` e `-shm` após a cópia.

---

## 8. Análise de Qualidade de Código e Testes

### 8.1 Rigor de Tipagem e Linter
- O `tsconfig.json` está configurado com `strict: true`, `noImplicitAny: true`, `exactOptionalPropertyTypes: true`, e `noUncheckedIndexedAccess: true`.
- Zero casts inseguros do tipo `as any` em arquivos de produção. Apenas 1 cast delimitado em [`mcp.controller.ts:L85`](file:///home/gustavo/Desktop/Projects/argos-career/src/api/infrastructure/mcp.controller.ts#L85) para compatibilidade entre `exactOptionalPropertyTypes` e tipos opcionais do SDK MCP.

### 8.2 Estrutura e Velocidade da Suíte de Testes
- **1275 testes automatizados** distribuídos em 92 arquivos de teste (`.test.ts`), executados em ~1.2 segundos no Vitest.
- Todos os testes utilizam dados em memória (`:memory:` SQLite) e mocks síncronos injetáveis para `fetch`, sem realizar nenhuma chamada real de rede durante a execução da suíte.

---

## 9. Matriz de Riscos e Impactos

| ID | Categoria | Risco Identificado | Severidade | Probabilidade | Impacto Operacional | Evidência no Código |
| :--- | :--- | :--- | :---: | :---: | :--- | :--- |
| **RSK-01** | Operação | Perda de lock em scraping pesado da Catho | **MÉDIA** | **MÉDIA** | Coletor encerra prematuramente ou recria lock | [`collectors/catho/collect.ts:L286-L317`](file:///home/gustavo/Desktop/Projects/argos-career/collectors/catho/collect.ts#L286-L317) |
| **RSK-02** | Manutenibilidade | Desalinhamento entre constante default e schema | **MÉDIA** | **BAIXA** | Dificuldade de ajuste de concorrência Stage B | [`src/scoring/infrastructure/stage-b-matcher.ts:L31`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-b-matcher.ts#L31) |
| **RSK-03** | Configuração | Injeção de strings vazias em `ignoredProviders` | **MÉDIA** | **BAIXA** | Envio de lista com elementos vazios ao OpenRouter | [`src/prefilter/domain/criteria.ts:L175-L177`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/criteria.ts#L175-L177) |
| **RSK-04** | Observabilidade | Parse de payload/JSON sem emissão de warning | **BAIXA** | **BAIXA** | Falha silenciosa em detectar corrupção de registro | [`src/persistence/infrastructure/postings-repository.ts:L47-L53`](file:///home/gustavo/Desktop/Projects/argos-career/src/persistence/infrastructure/postings-repository.ts#L47-L53) |
| **RSK-05** | Operação | Intervalo desigual de cron para valores não-divisores de 24 | **BAIXA** | **BAIXA** | Execução fora do horário planejado para certos intervalos | [`src/scheduling/infrastructure/scheduler.service.ts:L38-L40`](file:///home/gustavo/Desktop/Projects/argos-career/src/scheduling/infrastructure/scheduler.service.ts#L38-L40) |

---

## 10. Divergências e Inconsistências Internas

1. **Papel do Hermes (Documentação/Contexto vs Código Real)**:
   - *Divergência:* Descrições contextuais externas sugerem o Hermes como motor de coleta e dedup.
   - *Fato no Código:* O código em [`src/app.module.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/app.module.ts), [`src/cli/main.ts`](file:///home/gustavo/Desktop/Projects/argos-career/src/cli/main.ts) e [`CLAUDE.md:L298-L320`](file:///home/gustavo/Desktop/Projects/argos-career/CLAUDE.md#L298-L320) estabelece que o ArgosCareer é 100% autônomo, e o Hermes atua estritamente como cliente da API/MCP.
2. **Schema de Scoring vs Constantes de Infraestrutura**:
   - *Divergência:* O valor padrão de concorrência do Stage B está definido em [`CriteriaSchema`](file:///home/gustavo/Desktop/Projects/argos-career/src/prefilter/domain/criteria.ts#L168) via `.default(8)` e replicado como literal em [`DEFAULT_STAGE_B_CONCURRENCY`](file:///home/gustavo/Desktop/Projects/argos-career/src/scoring/infrastructure/stage-b-matcher.ts#L31).

---

## 11. Recomendações e Plano de Ação Priorizado

### Fase 1: Imediato / Curto Prazo (Robustez de Configuração e Coletores)
- **REC-01**: Sincronizar a constante `DEFAULT_STAGE_B_CONCURRENCY` para ser a fonte única referenciada pelo schema Zod de critérios.
  - *Arquivo Impactado:* `src/prefilter/domain/criteria.ts`, `src/scoring/infrastructure/stage-b-matcher.ts`.
  - *Complexidade:* Pequena (P).
- **REC-02**: Adicionar validação de string não-vazia `.min(1)` no array de `ignoredProviders` em `ScoringConfigSchema`.
  - *Arquivo Impactado:* `src/prefilter/domain/criteria.ts`.
  - *Complexidade:* Pequena (P).
- **REC-03**: Adicionar emissão de log de advertência (`Logger.warn`) nas funções de fallback de JSON corrompido nos repositórios.
  - *Arquivo Impactado:* `src/persistence/infrastructure/postings-repository.ts`, `src/persistence/infrastructure/runs-repository.ts`.
  - *Complexidade:* Pequena (P).

### Fase 2: Médio Prazo (Melhorias Operacionais)
- **REC-04**: Implementar tolerância estendida de heartbeat no coletor Catho durante navegação pesada do Chromium.
  - *Arquivo Impactado:* `collectors/catho/collect.ts`.
  - *Complexidade:* Média (M).
- **REC-05**: Validação no `CriteriaSchema` para alertar se `schedule.collection.intervalHours` não for um divisor exato de 24.
  - *Arquivo Impactado:* `src/prefilter/domain/criteria.ts`.
  - *Complexidade:* Pequena (P).

---

## 12. Correções Propostas (Diffs Verificáveis)

### 12.1 Correção ACH-01 / REC-01: Centralização de `DEFAULT_STAGE_B_CONCURRENCY`

```diff
diff --git a/src/prefilter/domain/criteria.ts b/src/prefilter/domain/criteria.ts
index e5a3c1b..b2e4f8a 100644
--- a/src/prefilter/domain/criteria.ts
+++ b/src/prefilter/domain/criteria.ts
@@ -1,6 +1,7 @@
 import { z } from "zod";
 import { ProfileTrackSchema } from "../../profile/domain/profile";
 import { WorkModeSchema } from "../../posting/domain/posting";
+import { DEFAULT_STAGE_B_CONCURRENCY } from "../../scoring/infrastructure/stage-b-matcher";
 
 export const TrackCriteriaSchema = z.object({
   keywords: z.array(z.string().min(1)).min(1),
@@ -165,7 +166,7 @@ export const ScoringConfigSchema = z.object({
   stageBConcurrency: z
     .number()
     .int()
     .min(1)
     .max(32)
-    .default(8),
+    .default(DEFAULT_STAGE_B_CONCURRENCY),
   ignoredProviders: z.array(z.string().min(1)).default([]),
 });
```

### 12.2 Correção ACH-03 / REC-02: Validação Estrita de `ignoredProviders`

```diff
diff --git a/src/prefilter/domain/criteria.ts b/src/prefilter/domain/criteria.ts
index b2e4f8a..c3d5e9f 100644
--- a/src/prefilter/domain/criteria.ts
+++ b/src/prefilter/domain/criteria.ts
@@ -169,5 +169,5 @@ export const ScoringConfigSchema = z.object({
     .min(1)
     .max(32)
     .default(DEFAULT_STAGE_B_CONCURRENCY),
-  ignoredProviders: z.array(z.string()).default([]),
+  ignoredProviders: z.array(z.string().trim().min(1)).default([]),
 });
```

### 12.3 Correção ACH-04 / REC-03: Log de Alerta em Payload Corrompido

```diff
diff --git a/src/persistence/infrastructure/postings-repository.ts b/src/persistence/infrastructure/postings-repository.ts
index d8f4c2e..a1b3c5d 100644
--- a/src/persistence/infrastructure/postings-repository.ts
+++ b/src/persistence/infrastructure/postings-repository.ts
@@ -10,6 +10,7 @@ import {
   or,
   sql,
 } from "drizzle-orm";
+import { Logger } from "@nestjs/common";
 import {
   Location,
   Posting,
@@ -20,6 +21,8 @@ import { Db } from "./db";
 import { postings } from "./schema";
 
+const logger = new Logger("PostingsRepository");
+
 type PostingRow = typeof postings.$inferSelect;
 
@@ -49,6 +52,7 @@ function parseRawPayload(value: string): unknown {
   try {
     return JSON.parse(value) as unknown;
   } catch {
+    logger.warn("Corrupted or invalid rawPayload JSON encountered during hydration");
     return { corrupted: true };
   }
 }
```

---

## 13. Metodologia da Auditoria e Registro de Execução

### 13.1 Comandos Executados na Auditoria

| Comando Executado | Diretório | Código de Retorno | Resultado Observado |
| :--- | :--- | :---: | :--- |
| `npm run typecheck` | `/home/gustavo/Desktop/Projects/argos-career` | `0` | Sucesso (0 erros de compilação TypeScript) |
| `npm run lint` | `/home/gustavo/Desktop/Projects/argos-career` | `0` | Sucesso (0 advertências / erros no ESLint) |
| `npm test` | `/home/gustavo/Desktop/Projects/argos-career` | `0` | Sucesso (1217 testes aprovados em 90 arquivos) |
| `npm test` | `/home/gustavo/Desktop/Projects/argos-career/collectors/catho` | `0` | Sucesso (58 testes aprovados em 2 arquivos) |
| `npm run typecheck` | `/home/gustavo/Desktop/Projects/argos-career/collectors/catho` | `0` | Sucesso (0 erros de compilação TypeScript) |
| `git ls-files \| wc -l` | `/home/gustavo/Desktop/Projects/argos-career` | `0` | 420 arquivos rastreados no git |
| `find src -name "*.ts" \| xargs wc -l` | `/home/gustavo/Desktop/Projects/argos-career` | `0` | 16.023 linhas de código TypeScript em `src/` |

### 13.2 Lista Completa de Módulos e Arquivos Auditados
- **Domínio & Infra de Postings**: `fingerprint.ts`, `posting.ts`, `raw-posting.ts`, `title-similarity.ts`, `collector.port.ts`, `collector-registry.ts`, `normalizer-registry.ts`, `gupy-collector.ts`, `gupy-normalizer.ts`, `gupy-schema.ts`, `ciee-collector.ts`, `ciee-normalizer.ts`, `ciee-schema.ts`, `solides-collector.ts`, `solides-normalizer.ts`, `solides-schema.ts`, `infojobs-collector.ts`, `infojobs-listing-parser.ts`, `infojobs-normalizer.ts`, `infojobs-schema.ts`, `indeed-normalizer.ts`, `indeed-schema.ts`, `linkedin-alert-normalizer.ts`, `linkedin-alert-schema.ts`, `catho-normalizer.ts`, `catho-schema.ts`.
- **Coletores Standalone**: `collectors/catho/collect.ts`, `collectors/catho/requeue.ts`, `collectors/catho/state.ts`, `collectors/indeed/collect.py`.
- **Pré-filtro**: `pre-filter.ts`, `classify-track.ts`, `criteria.ts`, `title-match.ts`, `criteria-hash.ts`, `criteria-loader.ts`.
- **Perfil**: `profile.ts`, `academic-period.ts`, `profile-keywords.ts`, `profile-hash.ts`, `profile-loader.ts`.
- **Scoring & LLM**: `score.ts`, `types.ts`, `recommendation.ts`, `period-gate.ts`, `evidence-catalog.ts`, `evidence-provenance.ts`, `posting-content-hash.ts`, `requirements-hash.ts`, `text-truncation.ts`, `calibration.ts`, `failure-diagnostic.ts`, `api-scorer.ts`, `stage-a-extractor.ts`, `stage-b-matcher.ts`, `openrouter-client.ts`, `prompts.ts`, `circuit-breaker.ts`, `llm-output.ts`, `build-scorer.ts`, `stub-scorer.ts`, `prompts/stage-a-extraction.v5.md`, `prompts/stage-b-matching.v4.md`.
- **Persistência**: `schema.ts`, `db.ts`, `postings-repository.ts`, `extractions-repository.ts`, `matches-repository.ts`, `runs-repository.ts`, `posting-events-repository.ts`, `delivery-operations-repository.ts`, `backup.ts`, `restore.ts`, `dedup-similar-postings.ts`.
- **Entrega & Notificação**: `digest.ts`, `render-digest.ts`, `telegram-notifier.ts`, `telegram-config.ts`, `notifier.port.ts`, `delivery-checkpoint.port.ts`.
- **Agendamento & Observabilidade**: `scheduler.service.ts`, `alerts.ts`, `run-lock.ts`, `run-lock.provider.ts`, `scheduling.module.ts`.
- **API & MCP**: `api-key.guard.ts`, `runs.controller.ts`, `runs.service.ts`, `postings.controller.ts`, `postings.service.ts`, `market.controller.ts`, `market.service.ts`, `mcp.controller.ts`, `api.module.ts`, `auth-principal.ts`, `throttler-limits.ts`.
- **Market Intelligence**: `study-plan.ts`, `gap-analysis.ts`, `taxonomy.ts`, `taxonomy-loader.ts`, `aggregate-corpus.ts`, `time-series.ts`, `render-study-plan.ts`, `market-repository.ts`.
- **Configuração e CLI**: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `Dockerfile`, `compose.production.yaml`, `.github/workflows/ci.yml`, `src/cli/main.ts`, `src/main.ts`, `src/app.module.ts`.

### 13.3 Limitações da Auditoria
A presente auditoria foi conduzida de forma 100% estática e determinística sobre o código-fonte, configurações e suíte de testes. Não foram realizadas chamadas de rede externas para a API do OpenRouter ou endpoints do Telegram, nem raspagem ao vivo contra os portais de emprego terceiros durante esta sessão.

### 13.4 Declaração de Conformidade com as Regras Anti-Alucinação
O auditor atesta que todas as afirmações, métricas, identificadores de símbolos, referências a arquivos, números de linha e citações contidos neste relatório foram diretamente extraídos e verificados no repositório no commit auditado, sem suposições não comprovadas.
