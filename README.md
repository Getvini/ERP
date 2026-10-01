# Awesome Project Build with TypeORM

Steps to run this project:

1. Run `npm i` command
2. Setup database settings inside `data-source.ts` file
3. Run `npm start` command

## Kling video callback

The video-generation flow uses a signed Kling callback as the primary completion
signal and a database-backed reconciliation job as its fallback. Configure these
environment variables in the deployed backend:

- `KLING_WEBHOOK_SECRET`: the `whsec_...` signing secret created in Kling Console.
- `KLING_CALLBACK_URL`: the public HTTPS endpoint
  `https://<backend-host>/api/video-generations/kling/callback`.

If `KLING_CALLBACK_URL` is omitted, the backend derives it from
`RENDER_EXTERNAL_URL`. If no webhook secret is configured, creation still works
through the reconciliation job, but Kling callbacks are not requested.
