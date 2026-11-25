// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { sql } from '../common/sql.js';
import { PgEngine } from '../engines/pg-engine.js';
import type { ConnectionFields } from '../external/connection.js';
import { DatabaseCore } from './index.js';

const url = process.env.BLOCKS_TEST_POSTGRES_URL;

function connectionOf(databaseUrl: string): ConnectionFields {
	const { hostname, port, username, password, pathname } = new URL(databaseUrl);
	return {
		host: hostname,
		port: Number(port || 5432),
		user: decodeURIComponent(username),
		password: decodeURIComponent(password),
		database: decodeURIComponent(pathname.slice(1)),
	};
}

if (!url) {
	test('the PostgreSQL tests have a server to run on', (t) => {
		const fix = 'Set BLOCKS_TEST_POSTGRES_URL to the URL of a PostgreSQL database whose user may create a schema.';
		if (process.env.BLOCKS_REQUIRE_POSTGRES_TESTS === '1') assert.fail(fix);
		t.skip(fix);
	});
} else {
	describe('transaction() on PostgreSQL, with more than one pooled connection', () => {
		const schema = `blocks_tx_${randomBytes(6).toString('hex')}`;
		const connection = connectionOf(url);
		const admin = new pg.Pool({ ...connection, max: 1 });
		let engine: PgEngine;
		let core: DatabaseCore;

		const ids = async (): Promise<number[]> =>
			(await core.query<{ id: number }>(sql`SELECT id FROM entries ORDER BY id`)).map((row) => row.id);

		before(async () => {
			await admin.query(`CREATE SCHEMA ${schema}`);
			const pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
			engine = new PgEngine({ kind: 'external', connection, pool });
			core = new DatabaseCore({ engine: async () => engine });
			await core.execute(sql`CREATE TABLE entries (id integer PRIMARY KEY)`);
		});

		after(async () => {
			await engine.destroy();
			await admin.query(`DROP SCHEMA ${schema} CASCADE`);
			await admin.end();
		});

		beforeEach(async () => {
			await core.execute(sql`TRUNCATE entries`);
		});

		test('a block-level write inside the callback is rolled back with the transaction', async () => {
			await assert.rejects(
				core.transaction(async (tx) => {
					await tx.execute(sql`INSERT INTO entries VALUES (${1})`);
					await core.execute(sql`INSERT INTO entries VALUES (${2})`);
					throw new Error('the callback fails');
				}),
			);
			assert.deepStrictEqual(await ids(), []);
		});

		test('a block-level read inside the callback sees the write the transaction has not committed', async () => {
			const seen = await core.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO entries VALUES (${3})`);
				return {
					query: await core.query<{ id: number }>(sql`SELECT id FROM entries WHERE id = ${3}`),
					queryOne: await core.queryOne<{ id: number }>(sql`SELECT id FROM entries WHERE id = ${3}`),
				};
			});
			assert.deepStrictEqual(seen, { query: [{ id: 3 }], queryOne: { id: 3 } });
		});

		test('block-level and transaction writes are both kept when the callback returns', async () => {
			await core.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO entries VALUES (${4})`);
				await core.execute(sql`INSERT INTO entries VALUES (${5})`);
			});
			assert.deepStrictEqual(await ids(), [4, 5]);
		});

		test("another block's write inside the callback commits on its own, whatever the transaction does", async () => {
			const other = new DatabaseCore({ engine: async () => engine });
			await assert.rejects(
				core.transaction(async (tx) => {
					await tx.execute(sql`INSERT INTO entries VALUES (${6})`);
					await other.execute(sql`INSERT INTO entries VALUES (${7})`);
					throw new Error('the callback fails');
				}),
			);
			assert.deepStrictEqual(await ids(), [7]);
		});

		test('a statement the callback started and did not await runs on its own after the transaction ended', async () => {
			let transactionEnded = (): void => {};
			const ended = new Promise<void>((resolve) => {
				transactionEnded = resolve;
			});
			let late: Promise<unknown> = Promise.resolve();
			await assert.rejects(
				core.transaction(async () => {
					late = ended.then(() => core.execute(sql`INSERT INTO entries VALUES (${8})`));
					throw new Error('the callback fails');
				}),
			);
			transactionEnded();
			await late;
			assert.deepStrictEqual(await ids(), [8]);
		});
	});
}
