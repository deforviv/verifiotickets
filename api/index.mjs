import { handleRequest } from '../server.mjs';

export default async function vercelHandler(request, response) {
  const incoming = new URL(request.url, `https://${request.headers.host || 'localhost'}`);
  const apiPath = incoming.searchParams.get('__apiPath');

  if (apiPath !== null) {
    if (!apiPath || apiPath.startsWith('/') || apiPath.split('/').some(part => part === '..')) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      return response.end(JSON.stringify({ error: 'Chemin API invalide.' }));
    }
    incoming.searchParams.delete('__apiPath');
    const query = incoming.searchParams.toString();
    const originalUrl = request.url;
    request.url = `/api/${apiPath}${query ? `?${query}` : ''}`;
    try {
      return await handleRequest(request, response);
    } finally {
      request.url = originalUrl;
    }
  }

  return handleRequest(request, response);
}
