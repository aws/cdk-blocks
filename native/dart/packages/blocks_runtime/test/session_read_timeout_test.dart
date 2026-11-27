// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:fake_async/fake_async.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// A [TokenStore] whose reads complete only when the test says so, as a
/// secure storage read that hangs on a locked device does. Writes go to
/// [values] at once.
class _HangingTokenStore implements TokenStore {
  _HangingTokenStore([Map<String, String>? values]) : values = {...?values};

  final Map<String, String> values;
  final pending = <Completer<String?>>[];
  int reads = 0;

  /// When false, reads answer from [values] at once.
  bool hang = true;

  /// Completes every pending read with what [values] holds now.
  void release() {
    for (final read in pending) {
      read.complete(values['k']);
    }
    pending.clear();
  }

  /// Fails every pending read.
  void fail(Object error) {
    for (final read in pending) {
      read.completeError(error);
    }
    pending.clear();
  }

  @override
  Future<String?> get(String key) {
    reads++;
    if (!hang) return Future<String?>.value(values[key]);
    final read = Completer<String?>();
    pending.add(read);
    return read.future;
  }

  @override
  Future<void> set(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

final _api = Uri.parse('https://api.example.com/cdk-blocks/api');

/// The serialized cookie list a [PersistentSessionStore] writes for [cookies].
Future<String> _stored(Map<String, String> cookies) async {
  final storage = InMemoryTokenStore();
  final writer = PersistentSessionStore(store: storage, storageKey: 'k');
  for (final MapEntry(:key, :value) in cookies.entries) {
    writer.setCookies('$key=$value; Path=/', requestUri: _api);
  }
  await writer.flush();
  return (await storage.get('k'))!;
}

Map<String, String> _cookiesIn(String? serialized) => {
  for (final r
      in (jsonDecode(serialized!) as List<dynamic>)
          .cast<Map<String, dynamic>>())
    r['name'] as String: r['value'] as String,
};

http.Response _rpc(Object? result, {String? setCookie}) => http.Response(
  jsonEncode({'jsonrpc': '2.0', 'result': result, 'id': 1}),
  200,
  headers: {'content-type': 'application/json', 'set-cookie': ?setCookie},
);

void main() {
  const timeout = Duration(milliseconds: 100);

  group('PersistentSessionStore first read timeout', () {
    test('defaults to 5 seconds', () {
      expect(
        PersistentSessionStore.defaultReadTimeout,
        const Duration(seconds: 5),
      );
    });

    test('a call goes ahead without the stored session once the read has '
        'taken longer than readTimeout, and the timeout is reported', () async {
      final storage = _HangingTokenStore({
        'k': await _stored({'blocks_session': 'old'}),
      });
      final errors = <Object>[];
      final sent = <String?>[];
      final client = BlocksClient(
        baseUrl: _api.toString(),
        sessionStore: PersistentSessionStore(
          store: storage,
          storageKey: 'k',
          readTimeout: timeout,
          onPersistError: (error, _) => errors.add(error),
        ),
        client: MockClient((request) async {
          sent.add(request.headers['cookie']);
          return _rpc('ok');
        }),
      );

      final watch = Stopwatch()..start();
      expect(await client.call('api.ping', const []), 'ok');
      expect(watch.elapsed, greaterThanOrEqualTo(timeout));
      expect(sent, [null]);
      expect(errors, [isA<TimeoutException>()]);
    });

    test('later calls neither wait nor read again while the read is still '
        'running, and the timeout is reported once', () async {
      final storage = _HangingTokenStore();
      final errors = <Object>[];
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        readTimeout: timeout,
        onPersistError: (error, _) => errors.add(error),
      );
      await store.cookieHeaderFor(_api);

      // A change would retry a failed read; a read still running is waited
      // for instead of read twice.
      store.setCookies('blocks_session=new; Path=/', requestUri: _api);
      expect(
        await store.cookieHeaderFor(_api).timeout(timeout ~/ 2),
        'blocks_session=new',
      );
      await store.flush().timeout(timeout ~/ 2);
      expect(storage.reads, 1);
      expect(errors, hasLength(1));
    });

    test('a read that completes late does not replace a sign-in made '
        'meanwhile, and the merged session is then written', () async {
      final storage = _HangingTokenStore({
        'k': await _stored({'blocks_session': 'old', 'pref': 'dark'}),
      });
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        readTimeout: timeout,
        onPersistError: (_, _) {},
      );
      expect(await store.cookieHeaderFor(_api), isNull);

      // The user signs in while storage still hasn't answered. Nothing is
      // written yet: storage hasn't been read.
      store.setCookies('blocks_session=new; Path=/', requestUri: _api);
      await store.flush();
      expect(_cookiesIn(storage.values['k'])['blocks_session'], 'old');

      storage.release();
      await store.flush();
      await Future<void>.delayed(Duration.zero);
      await store.flush();

      // The sign-in wins; a cookie the app did not touch is adopted.
      expect(store.cookies, {'blocks_session': 'new', 'pref': 'dark'});
      expect(_cookiesIn(storage.values['k']), {
        'blocks_session': 'new',
        'pref': 'dark',
      });
    });

    test('a read that completes late after a sign-out brings nothing '
        'back', () async {
      final storage = _HangingTokenStore({
        'k': await _stored({'blocks_session': 'old'}),
      });
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        readTimeout: timeout,
        onPersistError: (_, _) {},
      );
      await store.cookieHeaderFor(_api);
      store.clear();
      await store.flush();
      // The read began before the sign-out deleted the session, so it
      // returns the old one.
      storage.values['k'] = await _stored({'blocks_session': 'old'});
      storage.release();
      await Future<void>.delayed(Duration.zero);

      expect(await store.cookieHeaderFor(_api), isNull);
      expect(store.cookies, isEmpty);
    });

    test('a read that fails late leaves the store retrying as a failed read '
        'does', () async {
      var now = DateTime.utc(2030);
      final storage = _HangingTokenStore({
        'k': await _stored({'blocks_session': 'old'}),
      });
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        clock: () => now,
        readTimeout: timeout,
        onPersistError: (_, _) {},
      );
      await store.cookieHeaderFor(_api);
      storage.fail(StateError('locked'));
      await Future<void>.delayed(Duration.zero);

      // Within the retry interval nothing is read; after it, storage is.
      storage.hang = false;
      expect(await store.cookieHeaderFor(_api), isNull);
      expect(storage.reads, 1);
      now = now.add(const Duration(seconds: 31));
      expect(await store.cookieHeaderFor(_api), 'blocks_session=old');
      expect(storage.reads, 2);
    });

    test('flush never throws and completes while the read hangs', () async {
      final storage = _HangingTokenStore();
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        readTimeout: timeout,
        onPersistError: (_, _) {},
      )..setCookies('blocks_session=new; Path=/', requestUri: _api);
      // Without a bound the queued write would wait on the read for good.
      await store.flush().timeout(timeout * 5);

      storage.fail(StateError('locked'));
      store.setCookies('other=1; Path=/', requestUri: _api);
      await store.flush().timeout(timeout * 5);
    });

    test('a read that hangs and a fast read leave no timer pending', () {
      fakeAsync((async) {
        final hanging = PersistentSessionStore(
          store: _HangingTokenStore(),
          storageKey: 'k',
          readTimeout: timeout,
          onPersistError: (_, _) {},
        );
        String? header = 'unset';
        hanging.cookieHeaderFor(_api).then((h) => header = h);
        async.flushMicrotasks();
        expect(async.pendingTimers, hasLength(1));
        async.elapse(timeout);
        expect(header, isNull);
        expect(async.pendingTimers, isEmpty);

        PersistentSessionStore(
          store: _HangingTokenStore()..hang = false,
          storageKey: 'k',
          readTimeout: timeout,
        ).cookieHeaderFor(_api);
        async.flushMicrotasks();
        expect(async.pendingTimers, isEmpty);
      });
    });

    test('a read that completes in time is used as before, with nothing '
        'reported', () async {
      final storage = _HangingTokenStore({
        'k': await _stored({'blocks_session': 'old'}),
      })..hang = false;
      final errors = <Object>[];
      final store = PersistentSessionStore(
        store: storage,
        storageKey: 'k',
        readTimeout: timeout,
        onPersistError: (error, _) => errors.add(error),
      );
      expect(await store.cookieHeaderFor(_api), 'blocks_session=old');
      await Future<void>.delayed(timeout * 2);
      expect(errors, isEmpty);
      expect(storage.reads, 1);
    });
  });
}
