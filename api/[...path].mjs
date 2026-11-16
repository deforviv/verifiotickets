import { handleRequest } from '../server.mjs';

export default async function vercelHandler(request, response) {
  await handleRequest(request, response);
}
