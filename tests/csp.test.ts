import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSP } from "../vite.config";

describe("Content-Security-Policy", () => {
  it("interdit toute connexion vers un autre domaine", () => {
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("'wasm-unsafe-eval'");
    expect(CSP).not.toMatch(/https?:/);
    expect(CSP).not.toContain("'unsafe-eval'");
    expect(CSP).not.toContain("'unsafe-inline'");
  });

  it("nginx envoie exactement la même politique (+ frame-ancestors) partout", () => {
    const conf = readFileSync(new URL("../deploy/nginx.conf", import.meta.url), "utf8");
    const headers = [...conf.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]);
    expect(headers.length).toBeGreaterThanOrEqual(3);
    for (const h of headers) expect(h).toBe(`${CSP}; frame-ancestors 'none'`);
  });
});

describe("nginx", () => {
  it("ne redéfinit pas la table des types MIME (sinon le HTML est téléchargé)", () => {
    const conf = readFileSync(new URL("../deploy/nginx.conf", import.meta.url), "utf8");
    const code = conf.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\btypes\s*\{/);
    expect(code).toMatch(/location = \/manifest\.webmanifest \{[^}]*default_type application\/manifest\+json/);
  });
});
