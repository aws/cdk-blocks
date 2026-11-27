// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import android.content.SharedPreferences
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.maps.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.test.runTest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.io.encoding.Base64
import kotlin.test.Test

class AndroidKeyValueStoreTest {

    private val prefs = FakeSharedPreferences()
    private val keys = FakeKeySource()
    private val legacy = FakeLegacyFile()
    private val warnings = mutableListOf<String>()

    private fun store() = AndroidKeyValueStore(
        prefs = { prefs },
        keys = keys,
        legacy = legacy,
        warn = { _, failure -> warnings += failure.message.orEmpty() },
    )

    @Test
    fun `round trips a value on a fresh install and stores it encrypted with a nonce in front`() = runTest {
        val store = store()
        store.put("jar", "hello")

        store.get("jar") shouldBe "hello"
        val stored = prefs.values.getValue("jar")
        stored shouldNotContain "hello"
        val raw = Base64.decode(stored)
        // 12-byte nonce, then the ciphertext and its 16-byte tag.
        raw.size shouldBe 12 + "hello".toByteArray().size + 16
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keys.key, GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        cipher.updateAAD("jar".toByteArray())
        String(cipher.doFinal(raw.copyOfRange(12, raw.size))) shouldBe "hello"
        legacy.deletes shouldBe 0
    }

    @Test
    fun `a value moved to another key does not decrypt`() = runTest {
        val store = store()
        store.put("jar", "hello")
        prefs.values["other"] = prefs.values.getValue("jar")

        shouldThrow<KeyValueStoreException> { store.get("other") }

        store.get("jar") shouldBe "hello"
    }

    @Test
    fun `returns null for a key that was never stored`() = runTest {
        store().get("missing").shouldBeNull()
    }

    @Test
    fun `a file left by an earlier version is deleted on first access and its entries are not imported`() = runTest {
        legacy.present = true

        store().get("jar").shouldBeNull()

        legacy.present shouldBe false
        legacy.deletes shouldBe 1
        prefs.values.shouldBeEmpty()
        warnings.shouldBeEmpty()
    }

    @Test
    fun `no file left by an earlier version means nothing is deleted`() = runTest {
        store().put("jar", "hello")

        legacy.deletes shouldBe 0
        warnings.shouldBeEmpty()
    }

    @Test
    fun `a file that cannot be deleted does not fail any access and is retried by the next instance`() = runTest {
        legacy.present = true
        legacy.deleteFailure = IllegalStateException("file busy")
        val store = store()

        store.get("jar").shouldBeNull()
        store.put("jar", "hello")
        store.get("jar") shouldBe "hello"
        store.clear()
        store.get("jar").shouldBeNull()

        // Once per instance: the cleanup runs with the first access, not with every one.
        legacy.attempts shouldBe 1
        warnings shouldContainExactly listOf("file busy")
        legacy.present shouldBe true

        legacy.deleteFailure = null
        store().get("jar").shouldBeNull()
        legacy.present shouldBe false
        legacy.attempts shouldBe 2
    }

    @Test
    fun `a file whose presence cannot be checked does not fail any access`() = runTest {
        legacy.existsFailure = IllegalStateException("cannot read")

        store().put("jar", "hello")
        store().get("jar") shouldBe "hello"

        warnings.size shouldBe 2
        legacy.deletes shouldBe 0
    }

    @Test
    fun `a sign-out holds while a file left by an earlier version is present`() = runTest {
        store().put("jar", "session")
        legacy.present = true
        legacy.deleteFailure = IllegalStateException("file busy")

        store().clear()

        store().get("jar").shouldBeNull()
        prefs.values.shouldBeEmpty()
    }

    @Test
    fun `the record left by the earlier migration is removed`() = runTest {
        store().put("jar", "hello")
        prefs.values["__migrated"] = "1700000000000:512"

        store().get("jar") shouldBe "hello"

        prefs.values.keys shouldContainExactly setOf("jar")
    }

    @Test
    fun `the record left by the earlier migration is not kept when a lost key drops the store`() = runTest {
        store().put("jar", "hello")
        prefs.values["__migrated"] = "1700000000000:512"
        prefs.removalsFail = true
        keys.key = null

        store().get("jar").shouldBeNull()

        prefs.values.shouldBeEmpty()
        keys.deleted shouldBe true
    }

    @Test
    fun `a write that did not reach disk is a write failure`() = runTest {
        val store = store()
        prefs.commitFails = true

        shouldThrow<KeyValueStoreException> { store.put("jar", "hello") }

        prefs.values.shouldBeEmpty()
    }

    @Test
    fun `clear reports a write that did not reach disk`() = runTest {
        val store = store()
        store.put("jar", "hello")
        prefs.commitFails = true

        shouldThrow<KeyValueStoreException> { store.clear() }

        prefs.values.keys shouldContainExactly setOf("jar")
    }

    @Test
    fun `a key the cipher refuses is a write failure`() = runTest {
        keys.key = KeyGenerator.getInstance("HmacSHA256").generateKey()

        shouldThrow<KeyValueStoreException> { store().put("jar", "hello") }

        prefs.values.shouldBeEmpty()
    }

    @Test
    fun `a key that cannot be created is a write failure`() = runTest {
        keys.createFailure = IllegalStateException("keystore busy")

        shouldThrow<KeyValueStoreException> { store().put("jar", "hello") }

        prefs.values.shouldBeEmpty()
        keys.key.shouldBeNull()
    }

    @Test
    fun `a key store that cannot answer is a read failure and keeps the entries`() = runTest {
        store().put("jar", "hello")
        keys.failure = IllegalStateException("keystore busy")

        shouldThrow<KeyValueStoreException> { store().get("jar") }

        prefs.values.keys shouldContainExactly setOf("jar")
        keys.deleted shouldBe false
    }

    @Test
    fun `a stored value shorter than a nonce is a read failure`() = runTest {
        val store = store()
        store.put("jar", "hello")
        prefs.values["jar"] = Base64.encode(ByteArray(5))

        shouldThrow<KeyValueStoreException> { store.get("jar") }

        prefs.values.keys shouldContainExactly setOf("jar")
    }

    @Test
    fun `a lost key whose entries cannot be cleared is a read failure`() = runTest {
        val store = store()
        store.put("jar", "hello")
        keys.key = null
        prefs.commitFails = true

        shouldThrow<KeyValueStoreException> { store().get("jar") }

        prefs.values.keys shouldContainExactly setOf("jar")
        keys.deleted shouldBe false
    }

    @Test
    fun `a lost key drops the entries and the next write works with a new one`() = runTest {
        val store = store()
        store.put("jar", "hello")
        keys.key = null

        store().get("jar").shouldBeNull()

        prefs.values.shouldBeEmpty()
        keys.deleted shouldBe true
        val recovered = store()
        recovered.put("jar", "after")
        recovered.get("jar") shouldBe "after"
        keys.key shouldNotBe null
    }

    @Test
    fun `a write after the key is lost drops the entries it can no longer read`() = runTest {
        store().put("jar", "hello")
        keys.key = null

        store().put("other", "after")

        prefs.values.keys shouldContainExactly setOf("other")
        store().get("other") shouldBe "after"
        keys.key shouldNotBe null
    }

    @Test
    fun `a value that does not decrypt with the key present is a read failure`() = runTest {
        val store = store()
        store.put("jar", "hello")
        prefs.values["jar"] = Base64.encode(ByteArray(12) + "garbage".toByteArray())

        shouldThrow<KeyValueStoreException> { store.get("jar") }

        prefs.values.keys shouldContainExactly setOf("jar")
    }

    @Test
    fun `two writes of the same value use different nonces`() = runTest {
        val store = store()
        store.put("jar", "hello")
        val first = Base64.decode(prefs.values.getValue("jar")).copyOfRange(0, 12)
        store.put("jar", "hello")
        val second = Base64.decode(prefs.values.getValue("jar")).copyOfRange(0, 12)

        first.contentEquals(second) shouldBe false
    }

    @Test
    fun `legacyPrefsPath is the AOSP shared_prefs location under the data dir`() {
        legacyPrefsPath("/data/data/com.example", "cookies").path shouldBe
            "/data/data/com.example/shared_prefs/cookies.xml"
    }

    @Test
    fun `legacyBackupPath is the file the platform restores from`() {
        legacyBackupPath(legacyPrefsPath("/data/data/com.example", "cookies")).path shouldBe
            "/data/data/com.example/shared_prefs/cookies.xml.bak"
    }

    @Test
    fun `causeChain walks from the throwable through every cause`() {
        val root = IllegalStateException("root")
        val mid = RuntimeException("mid", root)
        val top = Exception("top", mid)
        top.causeChain().toList() shouldContainExactly listOf(top, mid, root)
    }

    @Test
    fun `isKeystoreOwnFault is false below API 33 for any throwable`() {
        // Host Build.VERSION.SDK_INT is below TIRAMISU, so the version gate short-circuits; the
        // API 33+ cause-chain classification is the host suite's coverage boundary (device-only).
        Exception("boom").isKeystoreOwnFault() shouldBe false
    }

}

/** A JVM AES key stands in for the Keystore, which no plain JVM provides. */
private class FakeKeySource : KeySource {
    var key: SecretKey? = null
    var failure: Exception? = null
    var createFailure: Exception? = null
    var deleted = false

    override fun load(): SecretKey? {
        failure?.let { throw it }
        return key
    }

    override fun create(): SecretKey {
        createFailure?.let { throw it }
        return KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also {
            key = it
            deleted = false
        }
    }

    override fun delete() {
        key = null
        deleted = true
    }
}

private class FakeLegacyFile : LegacyFile {
    var present = false
    var existsFailure: Exception? = null
    var deleteFailure: Exception? = null
    var attempts = 0
    var deletes = 0

    override fun exists(): Boolean {
        existsFailure?.let { throw it }
        return present
    }

    override fun delete() {
        attempts += 1
        deleteFailure?.let { throw it }
        present = false
        deletes += 1
    }
}

private class FakeSharedPreferences : SharedPreferences {
    val values = mutableMapOf<String, String>()

    /** When set, every commit reports that it did not reach disk and changes nothing. */
    var commitFails = false

    /** When set, a commit that only removes entries reports that it did not reach disk. */
    var removalsFail = false

    override fun getAll(): MutableMap<String, *> = values.toMutableMap()

    override fun getString(key: String?, defValue: String?): String? =
        if (key != null && values.containsKey(key)) values[key] else defValue

    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues

    override fun getInt(key: String?, defValue: Int): Int = defValue

    override fun getLong(key: String?, defValue: Long): Long = defValue

    override fun getFloat(key: String?, defValue: Float): Float = defValue

    override fun getBoolean(key: String?, defValue: Boolean): Boolean = defValue

    override fun contains(key: String?): Boolean = values.containsKey(key)

    override fun edit(): SharedPreferences.Editor = Editor()

    override fun registerOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) {}

    override fun unregisterOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?,
    ) {}

    private inner class Editor : SharedPreferences.Editor {
        private val pending = mutableMapOf<String, String?>()
        private var clear = false

        override fun putString(key: String?, value: String?): SharedPreferences.Editor = apply {
            pending[key!!] = value
        }

        override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor = this

        override fun putInt(key: String?, value: Int): SharedPreferences.Editor = this

        override fun putLong(key: String?, value: Long): SharedPreferences.Editor = this

        override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = this

        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = this

        override fun remove(key: String?): SharedPreferences.Editor = apply { pending[key!!] = null }

        override fun clear(): SharedPreferences.Editor = apply { clear = true }

        override fun commit(): Boolean {
            if (commitFails) return false
            if (removalsFail && !clear && pending.values.all { it == null }) return false
            if (clear) values.clear()
            pending.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
            return true
        }

        override fun apply() {
            commit()
        }
    }
}
