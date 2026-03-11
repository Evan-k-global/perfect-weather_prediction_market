import './env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Field } from 'o1js';
import {
  TlsnWeatherAttestation,
  buildWeatherOracleStatementFromAttestation
} from './oracle-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const uiPath = path.join(packageRoot, 'public', 'demo-ui.html');

type BuildStatementRequest = {
  marketKey: string;
  allowedServerName: string;
  allowedRequestPath: string;
  maxAgeMs: number;
  thresholdTenthC: string;
  observedAtSlot: string;
  nonce: string;
  attestation: TlsnWeatherAttestation;
};

function writeJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT || '8787', 10);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        const html = await readFile(uiPath, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }

      if (req.method === 'POST' && req.url === '/api/build-statement') {
        const body = (await readJsonBody(req)) as BuildStatementRequest;
        const { statement, sourceHash, requestPathHash } = buildWeatherOracleStatementFromAttestation(
          Field(body.marketKey),
          body.attestation,
          {
            allowedServerName: body.allowedServerName,
            allowedRequestPath: body.allowedRequestPath,
            maxAgeMs: body.maxAgeMs
          },
          {
            jsonPath: ['current', 'temp_c'],
            thresholdTenthC: BigInt(body.thresholdTenthC),
            observedAtSlot: BigInt(body.observedAtSlot),
            nonce: Field(body.nonce)
          },
          Date.now()
        );

        writeJson(res, 200, {
          sourceHash: sourceHash.toString(),
          requestPathHash: requestPathHash.toString(),
          statement: {
            observedAtSlot: statement.observedAtSlot.toString(),
            observedValueTenthC: statement.observedValueTenthC.toString(),
            thresholdValueTenthC: statement.thresholdValueTenthC.toString(),
            outcome: statement.outcome.toField().toString(),
            nonce: statement.nonce.toString(),
            statementDigest: statement.statementDigest.toString()
          }
        });
        return;
      }

      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, 400, {
        error: error instanceof Error ? error.message : 'unknown error'
      });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Demo UI server listening on http://localhost:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error('[demo-ui-server] failed:', error);
  process.exit(1);
});
