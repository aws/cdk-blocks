// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import android.content.Context
import android.os.Build
import java.io.File

/**
 * The `EncryptedSharedPreferences` file named [name] that version 0.2.0 and earlier wrote. Nothing
 * reads it any more: 1.0.0 already kept the jar under a key that file never held, so it carries no
 * session this store could use, and it is only deleted.
 *
 * Its `MasterKey` Keystore alias is left in place. Every `EncryptedSharedPreferences` and
 * `EncryptedFile` in the application shares that alias, so deleting it could destroy the
 * application's own data, and a non-exportable key with no file behind it exposes nothing.
 */
internal class LegacyPrefsFile(private val name: String) : LegacyFile {

    private val context: Context get() = ContextProvider.applicationContext

    /**
     * `Context.getSharedPreferencesPath` is `@hide`, so this mirrors the location it derives. A
     * platform that moved `shared_prefs` would make [exists] false, which leaves the file behind
     * but never touches anything else.
     */
    private fun file(): File = legacyPrefsPath(context.applicationInfo.dataDir, name)

    private fun backupFile(): File = legacyBackupPath(file())

    /**
     * True only for a file the library wrote: one with the keysets `EncryptedSharedPreferences`
     * stores in plain text beside its entries. A plain file the application keeps under the same
     * name has neither, and is left alone. Reading them needs no decryption, so no library.
     */
    override fun exists(): Boolean {
        if (!file().exists()) return false
        val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
        return LEGACY_KEYSETS.all { prefs.contains(it) }
    }

    /**
     * Deletes the file rather than clearing it, and throws when it is still present afterwards so
     * the caller can report it; the next process tries again.
     */
    override fun delete() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            // Reported to return false on some builds for a file opened in no earlier call of this
            // process, so the file itself is what decides whether the delete took.
            val deleted = context.deleteSharedPreferences(name)
            check(deleted || !file().exists()) { "The platform did not delete the file for '$name'" }
        } else {
            // `deleteSharedPreferences` needs API 24; this branch serves minSdk 23 and mirrors what
            // it does, the backup file included: `SharedPreferencesImpl` renames a surviving backup
            // back over the file on its next load, which would bring the entries back.
            val cleared = context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
            val deleted = file().delete()
            val backupDeleted = backupFile().delete()
            check(!file().exists() && !backupFile().exists()) {
                "The file for '$name' is still present " +
                    "(cleared $cleared, deleted $deleted, backup deleted $backupDeleted)"
            }
        }
    }

    private companion object {
        /** The entries under which `EncryptedSharedPreferences` keeps a file's own keysets. */
        val LEGACY_KEYSETS = listOf(
            "__androidx_security_crypto_encrypted_prefs_key_keyset__",
            "__androidx_security_crypto_encrypted_prefs_value_keyset__",
        )
    }
}
