import type { RequestHandler } from './$types';
import { backendRequest } from '$lib/server/backend';

const proxy: RequestHandler = async ({ params, request }) => {
  const headers = new Headers(request.headers);
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('host');
  headers.delete('keep-alive');
  headers.delete('proxy-connection');
  headers.delete('te');
  headers.delete('trailer');
  headers.delete('transfer-encoding');
  headers.delete('upgrade');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const response = await backendRequest(params.path, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (cause) {
    console.error(`Backend request failed: ${request.method} /${params.path}`, cause);
    return Response.json(
      { message: 'The data service is temporarily unavailable. Your offline changes are safe and will retry.' },
      { status: 503, headers: { 'retry-after': '5' } }
    );
  }
};

export const GET = proxy;
export const PUT = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
