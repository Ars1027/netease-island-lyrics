const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NetEaseProcessWatcher,
  queryNetEaseProcess,
  tasklistHasNetEase,
} = require('../src/services/netease-process-watcher');

test('parses tasklist CSV output without depending on localized text', () => {
  assert.equal(tasklistHasNetEase('"cloudmusic.exe","6888","Console","1","410,000 K"'), true);
  assert.equal(tasklistHasNetEase('"CloudMusic.exe","42","Console","1","100 K"'), true);
  assert.equal(tasklistHasNetEase('INFO: No tasks are running which match the specified criteria.'), false);
});

test('one-shot process confirmation uses the same localized-output-independent parser', async () => {
  const running = await queryNetEaseProcess((_executable, _arguments, _options, callback) => {
    callback(null, '"cloudmusic.exe","42","Console","1","100 K"');
  });
  assert.equal(running, true);
});

test('a stopped generation cannot overwrite state after the watcher restarts', () => {
  const requests = [];
  const changes = [];
  const watcher = new NetEaseProcessWatcher({
    onChange: (running) => changes.push(running),
    execFileImpl(_executable, _arguments, _options, callback) {
      const request = { callback, killed: false };
      requests.push(request);
      return { kill() { request.killed = true; } };
    },
  });

  watcher.start();
  watcher.stop();
  watcher.start();
  requests[0].callback(null, '"cloudmusic.exe","42"');
  requests[1].callback(null, 'INFO: no matching tasks');

  assert.equal(requests[0].killed, true);
  assert.deepEqual(changes, [false]);
  watcher.stop();
});
