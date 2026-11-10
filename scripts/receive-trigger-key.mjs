import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";

const envPath = "C:/Users/Mounir/Desktop/hackerai/stack/.env";
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/trigger-key") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret.startsWith("tr_dev_")) {
    res.writeHead(400).end("invalid");
    return;
  }
  let env = await readFile(envPath, "utf8");
  const line = `TRIGGER_SECRET_KEY=${secret}`;
  const pattern = /^TRIGGER_SECRET_KEY=.*$/m;
  env = pattern.test(env) ? env.replace(pattern, line) : `${env.trimEnd()}\n${line}\n`;
  await writeFile(envPath, env, "utf8");
  res.writeHead(204).end();
  setImmediate(() => server.close());
});

server.listen(45999, "127.0.0.1");
