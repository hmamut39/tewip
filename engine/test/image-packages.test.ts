// Phase 146: what the image installs, which no lockfile records.
//
// A bill of materials built from package-lock.json lists what the application depends on and says
// nothing about the operating system under it - which is where most published container
// vulnerabilities actually are. A team that generates CycloneDX from their lockfile and files it
// as "our SBOM" has a document that is accurate and answers a different question.
//
// Reading the image needs a registry and a layer walk. A Dockerfile *states* what it installs, in
// the file, and that is the part a lockfile can never cover.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baseImages, imagePackages } from '../sbom/image-packages.ts';
import { isDockerfile } from '../iac/dockerfile.ts';

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const read = (...lines: string[]) => imagePackages('Dockerfile', lines.join(NL));
const named = (ps: ReturnType<typeof imagePackages>) => ps.map((p) => `${p.name}${p.version ? `@${p.version}` : ''}`).sort();

describe('what a Dockerfile installs', () => {
  it('reads the installers people actually use', () => {
    const found = read(
      'RUN apt-get install -y curl',
      'RUN apk add --no-cache openssl',
      'RUN yum install -y httpd-2.4.57',
      'RUN pip install requests==2.31.0',
      'RUN npm install -g pnpm@9.1.0',
      'RUN gem install bundler:2.5.6',
    );
    assert.deepEqual(named(found), ['bundler@2.5.6', 'curl', 'httpd@2.4.57', 'openssl', 'pnpm@9.1.0', 'requests@2.31.0']);
  });

  it('tells a pinned version from none', () => {
    const found = read('RUN apt-get install -y curl openssl=3.0.11-1');
    assert.equal(found.find((p) => p.name === 'curl')?.version, null);
    assert.equal(found.find((p) => p.name === 'openssl')?.version, '3.0.11-1');
  });

  it('does not read a flag as a package', () => {
    // immich's machine-learning image, exactly: seven packages after two flags.
    const found = read('RUN apt-get update && apt-get install -y --no-install-recommends g++ make patch git');
    assert.deepEqual(named(found), ['g++', 'git', 'make', 'patch']);
  });

  it('does not read a requirements file as a package', () => {
    assert.deepEqual(read('RUN pip install -r requirements.txt'), []);
    assert.deepEqual(read('RUN pip install ./dist/thing.whl'), []);
    assert.deepEqual(read('RUN pip install https://example.com/x.tar.gz'), []);
  });

  it('follows a line continued over several lines', () => {
    const found = read('RUN apt-get install -y curl ' + BS, '    git ' + BS, '    && rm -rf /var/lib/apt/lists/*');
    assert.deepEqual(named(found), ['curl', 'git']);
  });

  it('stops at the end of the install command', () => {
    // `rm` and `/var/lib/apt/lists/*` are the next command, not more packages.
    const found = read('RUN apt-get install -y curl && rm -rf /var/lib/apt/lists/*');
    assert.deepEqual(named(found), ['curl']);
  });

  it('reads nothing from an image that installs nothing', () => {
    assert.deepEqual(read('FROM node:20-slim', 'COPY . /app', 'CMD ["node", "index.js"]'), []);
  });
});

describe('the base images, which are the part this cannot see inside', () => {
  // This test was called "leaves out the stage names" and asserted that `builder` was one of them.
  // The intent was written down and the output it actually got was recorded as expected, so it
  // passed while the thing it is named for did not work: immich's evidence pack reported seven of
  // its own build stages - `builder`, `prod-cpu`, `sdk`, `dev`, `plugin-sdk` - as base images.
  it('names each one once, and leaves out the stage names', () => {
    const bases = baseImages(['FROM node:20-slim AS builder', 'FROM node:20-slim AS runner', 'FROM builder', 'FROM gcr.io/distroless/nodejs20'].join(NL));
    assert.deepEqual(bases, ['node:20-slim', 'gcr.io/distroless/nodejs20']);
  });

  it('leaves out a stage whose name is only defined later in the file', () => {
    // Reading once, in order, would not know `sdk` was a stage when it reached `FROM sdk`.
    assert.deepEqual(baseImages(['FROM sdk', 'FROM alpine:3.19 AS sdk'].join(NL)), ['alpine:3.19']);
  });

  it('keeps an image whose name merely looks like a word', () => {
    // `scratch` and `alpine` are real images, and nothing in the file declares them as stages.
    assert.deepEqual(baseImages(['FROM scratch', 'FROM alpine'].join(NL)), ['scratch', 'alpine']);
  });

  it('leaves out a stage selected by a build argument', () => {
    // immich's `FROM builder-${DEVICE}` picks one of several stages at build time, and reading the
    // file cannot say which - so it is not an image this can name.
    assert.deepEqual(baseImages(['FROM nvidia/cuda:12.2.2-runtime-ubuntu22.04 AS builder-cuda', 'FROM builder-${DEVICE}'].join(NL)), [
      'nvidia/cuda:12.2.2-runtime-ubuntu22.04',
    ]);
  });

  it('leaves out an image that is a build argument', () => {
    assert.deepEqual(baseImages('FROM $BASE_IMAGE' + NL + 'FROM alpine:3.19'), ['alpine:3.19']);
  });
});

describe('what counts as a Dockerfile', () => {
  it('is not a source file about Dockerfiles', () => {
    // `^dockerfile($|[.-])` matches `dockerfile.ts`, because `.` is in that class. Tewip read its
    // own engine/iac/dockerfile.ts as a Dockerfile and reported "1 Dockerfile" on a repository
    // with none - and `tewip infra` had done so since the day it was written.
    assert.equal(isDockerfile('dockerfile.ts'), false);
    assert.equal(isDockerfile('Dockerfile.js'), false);
    assert.equal(isDockerfile('dockerfile.py'), false);
  });

  it('is the shapes a real one takes', () => {
    assert.equal(isDockerfile('Dockerfile'), true);
    assert.equal(isDockerfile('dockerfile'), true);
    assert.equal(isDockerfile('Dockerfile.prod'), true);
    assert.equal(isDockerfile('Dockerfile-alpine'), true);
    assert.equal(isDockerfile('api.dockerfile'), true);
  });
});
