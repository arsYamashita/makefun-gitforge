import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http.ts';

export async function handleGraphql(_req: IncomingMessage, res: ServerResponse, _url: URL): Promise<void> {
  sendJson(res, 404, { message: 'Not Found' });
}
