// Unit coverage for scripts/build-gallery.mjs's CRLF-insensitive fingerprint
// (normalizeEol, collectDocument). A Windows checkout (core.autocrlf) reads
// materials/*.mtlx as CRLF while the published site was built from an LF
// checkout on Linux; the fingerprint must hash identically either way so a
// deploy still reuses the published thumbnail instead of rendering a
// placeholder. Verified against the real repo materials in the manual
// investigation; this test only needs synthetic fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeEol, collectDocument } from '../../scripts/build-gallery.mjs';

test('normalizeEol converts CRLF to LF and leaves LF untouched', () => {
  assert.equal(normalizeEol('a\r\nb\r\nc'), 'a\nb\nc');
  assert.equal(normalizeEol('a\nb\nc'), 'a\nb\nc');
});

test('collectDocument hashes LF and CRLF variants of the same document identically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mtlx-gallery-hash-'));
  try {
    const lfXml = '<materialx version="1.39">\n  <standard_surface name="s" type="surfaceshader"/>\n</materialx>\n';
    const crlfXml = lfXml.replace(/\n/g, '\r\n');

    const lfPath = path.join(dir, 'doc-lf.mtlx');
    const crlfPath = path.join(dir, 'doc-crlf.mtlx');
    await writeFile(lfPath, lfXml, 'utf8');
    await writeFile(crlfPath, crlfXml, 'utf8');

    const lfResult = await collectDocument(lfPath, lfXml);
    const crlfResult = await collectDocument(crlfPath, crlfXml);

    assert.equal(crlfResult.hash, lfResult.hash, 'CRLF checkout must fingerprint the same as an LF checkout');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectDocument LF hash matches the pre-normalization algorithm (plain sha256 of the LF text)', async () => {
  const { createHash } = await import('node:crypto');
  const dir = await mkdtemp(path.join(tmpdir(), 'mtlx-gallery-hash-'));
  try {
    const lfXml = '<materialx version="1.39">\n  <standard_surface name="s" type="surfaceshader"/>\n</materialx>\n';
    const lfPath = path.join(dir, 'doc-lf.mtlx');
    await writeFile(lfPath, lfXml, 'utf8');

    const result = await collectDocument(lfPath, lfXml);
    const expected = createHash('sha256').update(lfXml).digest('hex').slice(0, 16);

    assert.equal(result.hash, expected, 'LF input must still hash exactly as the old (pre-normalization) algorithm did');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
