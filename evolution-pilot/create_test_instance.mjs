import fs from "node:fs/promises";

const envText = await fs.readFile(new URL("./.env", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const response = await fetch("http://127.0.0.1:8080/instance/create", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: env.AUTHENTICATION_API_KEY,
  },
  body: JSON.stringify({
    instanceName: "wa_01",
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
  }),
});

const body = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(body));
  process.exit(1);
}

const base64 = body?.qrcode?.base64;
if (base64) {
  const encoded = base64.replace(/^data:image\/png;base64,/, "");
  await fs.writeFile(new URL("./wa_01_qr.png", import.meta.url), Buffer.from(encoded, "base64"));
}

console.log(JSON.stringify({
  instanceName: body?.instance?.instanceName ?? "wa_01",
  status: body?.instance?.status ?? body?.instance?.connectionStatus ?? "created",
  qrSaved: Boolean(base64),
}));
