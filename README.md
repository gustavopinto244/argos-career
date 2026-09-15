# Job Radar

Aplicação simplificada para buscar vagas e enviá-las diariamente ao Telegram.

```
Coleta (a cada 4h) → normalização → deduplicação → Telegram (diariamente)
```

Ela não lê currículo, perfil, competências ou disponibilidade. Também não usa
LLM, não calcula compatibilidade e não avalia uma vaga contra uma pessoa.

## Configuração

1. Copie `.env.example` para `.env` e informe as credenciais de **outro** bot
   do Telegram em `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.
2. Edite [`config/job-radar.yaml`](config/job-radar.yaml) quando a posição e a
   localidade forem definidas. Enquanto isso, ele usa uma busca ampla para
   Brasil e trabalho remoto.
3. Execute `npm run build` e `npm run start`.

`npm run cli -- collect` executa a coleta configurada e `npm run cli --
deliver` envia as vagas ainda não notificadas. Cada vaga é enviada uma vez;
se o Telegram falhar, ela fica pendente para a próxima execução.
