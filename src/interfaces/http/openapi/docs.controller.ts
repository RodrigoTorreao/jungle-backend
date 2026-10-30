import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { buildOpenApiDocument } from './spec';

/** Swagger UI's static files (pinned `swagger-ui-dist`, served locally — no CDN). */
export const SWAGGER_UI_ASSETS = dirname(
  createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'),
);
export const SWAGGER_UI_PREFIX = '/docs/assets';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Jungle Wagering API</title>
  <link rel="stylesheet" href="${SWAGGER_UI_PREFIX}/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${SWAGGER_UI_PREFIX}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      persistAuthorization: true,
      displayRequestDuration: true,
    });
  </script>
</body>
</html>`;

/** The API contract: machine-readable at /openapi.json, interactive at /docs. */
@Public()
@Controller()
export class DocsController {
  private readonly document = buildOpenApiDocument();

  @Get('openapi.json')
  openapi(): Record<string, unknown> {
    return this.document;
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    return PAGE;
  }
}
