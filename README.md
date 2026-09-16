# Job Radar

Aplicação simplificada para buscar vagas e enviá-las diariamente ao Telegram.

```
Coleta (a cada 4h) → normalização → deduplicação → filtro de vagas → Telegram (diariamente)
```

Ela não lê currículo, perfil, competências ou disponibilidade. Também não usa
LLM, não calcula compatibilidade e não avalia uma vaga contra uma pessoa.

## Configuração

1. Copie `.env.example` para `.env.job-radar` e informe as credenciais de **outro** bot
   do Telegram em `TELEGRAM_BOT_TOKEN`. Envie `/start` ao bot para se inscrever.
2. A busca em [`config/job-radar.yaml`](config/job-radar.yaml) procura cargos
   generalistas presenciais em Joinville ou remotos no Brasil.
3. Execute `npm run build` e `npm run start`.

`npm run cli -- collect` executa a coleta configurada e `npm run cli --
deliver` envia as vagas ainda não notificadas. Cada vaga é enviada uma vez;
se o Telegram falhar, ela fica pendente para a próxima execução.

O filtro aceita analista, auxiliar, assistente, negociador, atendente,
recepcionista, operador e vendedor quando a descrição informa ensino médio,
fundamental ou dispensa de faculdade. Exclui exigência de faculdade (inclusive
em andamento), formação técnica, cargos especializados, pleno/sênior e híbridos.
Faculdade descrita como desejável ou diferencial pode passar. Qualificações ou
localização ausentes ficam fora do envio. As regras são textuais e conservadoras;
não substituem a leitura dos requisitos da vaga. Remotos com restrição explícita
de residência também ficam fora.

O bot aceita qualquer pessoa que envie `/start` em conversa privada. `/stop`
cancela a inscrição. Os assinantes e o histórico de envio por conversa ficam
no banco da fork. Não é necessário configurar `TELEGRAM_CHAT_ID`.

Os envios ocorrem às 07h e 14h (America/Sao_Paulo). Cada mensagem contém
no máximo 20 vagas; lotes maiores são divididos em mensagens adicionais.
O limite de caracteres do Telegram pode produzir mensagens menores.

## Deploy independente

Use um checkout da branch `fork/job-radar-generic` em outro diretório no Atlas,
com seu próprio `.env.job-radar`. Execute
`docker compose -f compose.production.yaml up -d --build`.
O projeto, container e imagem se chamam `job-radar`; o volume de dados é
`job-radar_radar-data`. O container `argos-career` permanece independente.
Execute apenas uma instância da fork por token para consultar `/start` e `/stop`.
