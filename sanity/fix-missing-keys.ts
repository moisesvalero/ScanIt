import { getCliClient } from 'sanity/cli';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function randomKey(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2, 10)}`;
}

function addMissingArrayKeys(value: JsonValue, path = 'root', inArray = false): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) => addMissingArrayKeys(item, `${path}-${index + 1}`, true));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const obj = value as Record<string, JsonValue>;
  const out: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(obj)) {
    out[key] = addMissingArrayKeys(child, `${path}-${key}`, false);
  }

  if (inArray && typeof out._key !== 'string') {
    out._key = randomKey(path);
  }

  return out;
}

async function main() {
  const client = getCliClient({ apiVersion: '2025-01-01' });
  const docs = await client.fetch<Array<Record<string, JsonValue>>>(
    `*[_type in ["sitePortfolio", "caseStudy"]]`
  );

  let updated = 0;
  for (const doc of docs) {
    const fixed = addMissingArrayKeys(doc) as Record<string, JsonValue>;
    await client.createOrReplace(fixed);
    updated += 1;
  }

  console.log(`Keys revisadas y guardadas en ${updated} documento(s).`);
}

main().catch((error) => {
  console.error('Error corrigiendo keys en arrays:', error);
  process.exit(1);
});
