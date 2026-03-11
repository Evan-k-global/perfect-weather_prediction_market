import './env.js';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type AgentModel = {
  id: string;
  name: string;
  owner: string;
  price: number;
  description: string;
  mode: 'random-demo' | 'external';
};

type EscrowOrder = {
  id: string;
  buyer: string;
  agentId: string;
  amount: number;
  promptHash: string;
  encryptedPrompt: string;
  status: 'FUNDED' | 'RELAYED' | 'SETTLED' | 'REFUNDED';
  relayerFee: number;
  relayerOutputCommitment?: string;
  relayerOutputCiphertext?: string;
  revealedOutput?: string;
  createdAtUnixMs: number;
};

const agents: AgentModel[] = [
  {
    id: 'default-random-weather',
    name: 'Default Random Predictor',
    owner: 'protocol',
    price: 50,
    description: 'Demo model that outputs a pseudo-random weather probability.',
    mode: 'random-demo'
  }
];

const orders: Record<string, EscrowOrder> = {};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodePrivatePayload(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodePrivatePayload(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function randomPredictionOutput(promptHash: string): string {
  const entropy = Number.parseInt(promptHash.slice(0, 8), 16) % 10000;
  const p = entropy / 10000;
  return JSON.stringify({
    probability_yes: p,
    probability_no: 1 - p,
    confidence: Math.min(0.95, 0.35 + p / 2),
    note: 'demo-random-model'
  });
}

function writeJson(res: import('node:http').ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data, null, 2));
}

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const widgetPath = path.resolve(__dirname, '..', 'public', 'agent-widget.html');
  const port = Number.parseInt(process.env.AGENT_MARKET_PORT || '8789', 10);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/widget')) {
        const html = await readFile(widgetPath, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/agents') {
        writeJson(res, 200, { agents });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/agents/register') {
        const body = await readJsonBody(req);
        const model: AgentModel = {
          id: randomUUID(),
          name: requireString(body.name, 'name'),
          owner: requireString(body.owner, 'owner'),
          price: requireNumber(body.price, 'price'),
          description: requireString(body.description, 'description'),
          mode: 'external'
        };
        agents.push(model);
        writeJson(res, 200, { agent: model });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/orders/create') {
        const body = await readJsonBody(req);
        const buyer = requireString(body.buyer, 'buyer');
        const agentId = requireString(body.agentId, 'agentId');
        const prompt = requireString(body.prompt, 'prompt');
        const agent = agents.find((a) => a.id === agentId);
        if (!agent) throw new Error('agent not found');
        const relayerFee = Math.max(1, Math.floor(agent.price * 0.05));
        const order: EscrowOrder = {
          id: randomUUID(),
          buyer,
          agentId,
          amount: agent.price,
          promptHash: sha256Hex(prompt),
          encryptedPrompt: encodePrivatePayload(prompt),
          status: 'FUNDED',
          relayerFee,
          createdAtUnixMs: Date.now()
        };
        orders[order.id] = order;
        writeJson(res, 200, { order });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/relay-run')) {
        const orderId = url.pathname.split('/')[3];
        const order = orders[orderId];
        if (!order) throw new Error('order not found');
        if (order.status !== 'FUNDED') throw new Error('order must be FUNDED');
        const agent = agents.find((a) => a.id === order.agentId);
        if (!agent) throw new Error('agent missing');
        const prompt = decodePrivatePayload(order.encryptedPrompt);
        const output = agent.mode === 'random-demo' ? randomPredictionOutput(order.promptHash) : `{"note":"external model pending","prompt":"${prompt}"}`;
        const outputCommitment = sha256Hex(output);
        order.relayerOutputCommitment = outputCommitment;
        order.relayerOutputCiphertext = encodePrivatePayload(output);
        order.status = 'RELAYED';
        writeJson(res, 200, { order });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/orders/') && url.pathname.endsWith('/reveal-settle')) {
        const orderId = url.pathname.split('/')[3];
        const body = await readJsonBody(req);
        const output = requireString(body.output, 'output');
        const order = orders[orderId];
        if (!order) throw new Error('order not found');
        if (order.status !== 'RELAYED') throw new Error('order must be RELAYED');
        const digest = sha256Hex(output);
        if (digest !== order.relayerOutputCommitment) {
          throw new Error('output commitment mismatch');
        }
        order.revealedOutput = output;
        order.status = 'SETTLED';
        writeJson(res, 200, {
          order,
          payouts: {
            agentAmount: order.amount - order.relayerFee,
            relayerFee: order.relayerFee
          }
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/orders/')) {
        const orderId = url.pathname.split('/')[3];
        const order = orders[orderId];
        if (!order) throw new Error('order not found');
        writeJson(res, 200, { order });
        return;
      }

      writeJson(res, 404, { error: 'not found' });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Agent marketplace listening on http://127.0.0.1:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error('[agent-marketplace-server] failed:', error);
  process.exit(1);
});
