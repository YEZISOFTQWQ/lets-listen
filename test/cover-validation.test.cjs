'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'cover-validation.js'), 'utf8');

function validatorFor(decode, { width = 1, height = 1, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let image;
  class FakeImage {
    constructor() {
      image = this;
      this.naturalWidth = width;
      this.naturalHeight = height;
      this.src = '';
    }

    decode() { return decode(); }
  }
  const context = { Image: FakeImage, setTimeout: schedule, clearTimeout: cancel };
  vm.runInNewContext(source, context, { filename: 'cover-validation.js' });
  return { validate: context.validateCoverImage, image: () => image };
}

test('accepts a decoded image and rejects an invalid or empty image', async () => {
  await validatorFor(() => Promise.resolve()).validate('data:image/png;base64,valid');
  await assert.rejects(validatorFor(() => Promise.reject(new Error('bad image'))).validate('bad'), /无法解码/);
  await assert.rejects(validatorFor(() => Promise.resolve(), { width: 0 }).validate('bad'), /无法解码/);
});

test('times out an image decoder that never settles', async () => {
  const subject = validatorFor(() => new Promise(() => {}), {
    schedule: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    cancel: () => {},
  });
  await assert.rejects(subject.validate('bad'), /无法解码/);
  assert.equal(subject.image().src, '');
});
