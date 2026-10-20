'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createProject } = require('./harness');

function setup() {
  return createProject({ files: ['Logging.js', 'State.js'] });
}

test('up to 5 favorite sheets (tabs) can be added per document', () => {
  const { context } = setup();
  ['A', 'B', 'C', 'D', 'E'].forEach((name) => {
    assert.equal(context.addFavSheet('111', 'file1', name), true, name + ' should be accepted');
  });
  assert.deepEqual(context.getFavSheets('111', 'file1'), ['A', 'B', 'C', 'D', 'E']);
});

test('a 6th favorite sheet is rejected and the list is left unchanged', () => {
  const { context } = setup();
  ['A', 'B', 'C', 'D', 'E'].forEach((name) => context.addFavSheet('111', 'file1', name));

  assert.equal(context.addFavSheet('111', 'file1', 'F'), false);
  assert.deepEqual(context.getFavSheets('111', 'file1'), ['A', 'B', 'C', 'D', 'E']);
});

test('removing a favorite sheet frees a slot', () => {
  const { context } = setup();
  ['A', 'B', 'C', 'D', 'E'].forEach((name) => context.addFavSheet('111', 'file1', name));

  assert.equal(context.removeFavSheet('111', 'file1', 'C'), true);
  assert.equal(context.addFavSheet('111', 'file1', 'F'), true);
});

test('the favorite-sheet limit is per document, not shared across documents', () => {
  const { context } = setup();
  ['A', 'B', 'C', 'D', 'E'].forEach((name) => context.addFavSheet('111', 'file1', name));
  assert.equal(context.addFavSheet('111', 'file2', 'A'), true);
});

test('favorite documents stay capped at 3 (only the sheets limit changed)', () => {
  const { context } = setup();
  const doc = (n) => ({ fileId: 'f' + n, fileName: 'Doc ' + n, folderId: 'x', folderIndex: 0, folderName: 'X' });
  [1, 2, 3].forEach((n) => assert.equal(context.addFavDoc('111', doc(n)), true));
  assert.equal(context.addFavDoc('111', doc(4)), false);
});
