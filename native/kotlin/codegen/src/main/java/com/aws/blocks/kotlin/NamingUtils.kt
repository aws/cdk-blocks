// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

object NamingUtils {
    /**
     * Characters Kotlin rejects in a name even inside backticks (the JVM's `.;[]/<>:\`), and the
     * backtick, which ends a backticked name.
     */
    private val UNESCAPABLE_CHARACTERS = setOf('.', ';', '[', ']', '/', '<', '>', ':', '\\', '`')

    /**
     * Whether Kotlin can declare the spec name [name] as written, with backticks where it needs
     * them (`class`, `content-type`, `1st`, `a$b`), which KotlinPoet adds, and Android can load
     * the result. It can't declare an empty name, or one holding a character from
     * [UNESCAPABLE_CHARACTERS] (KotlinPoet throws "Can't escape identifier") or a control
     * character (a line break ends a backticked name).
     *
     * Android rejects many more: a property, function or class becomes a DEX field, method or
     * class name, and `d8` fails the Android build on one that isn't a DEX SimpleName
     * ([isDexSimpleName]), though Kotlin compiled it: "Field name 'c#' cannot be represented in
     * dex format", or "Space characters in SimpleName 'a b' are not allowed prior to DEX version
     * 040". So `it's`, `a b` and `c#` aren't declarable either.
     */
    fun isDeclarable(name: String): Boolean =
        name.isNotEmpty() &&
            name.none { it in UNESCAPABLE_CHARACTERS || it.isISOControl() } &&
            isDexSimpleName(name)

    /**
     * Whether [name] is a DEX SimpleName that `d8` accepts at the runtime's `minSdk` 23, which
     * emits DEX before version 040: each code point is [isDexNameChar]. An unpaired surrogate is
     * not one.
     */
    fun isDexSimpleName(name: String): Boolean {
        var i = 0
        while (i < name.length) {
            val codePoint = name.codePointAt(i)
            if (Character.isSurrogate(name[i]) && Character.charCount(codePoint) == 1) return false
            if (!isDexNameChar(codePoint)) return false
            i += Character.charCount(codePoint)
        }
        return true
    }

    /**
     * Whether [codePoint] can appear in a DEX SimpleName before version 040: an allowlist, since
     * DEX admits only letters, digits, `$`, `-` and `_` from ASCII, plus these Unicode ranges. It
     * leaves out the spaces (U+00A0, U+2000–U+200A, U+202F, which DEX 040 admits), the
     * zero-width and direction marks (U+200B–U+200F), the line and paragraph separators
     * (U+2028–U+2029), the bidi controls (U+202A–U+202E) and U+FFF0–U+FFFF. `d8` enforces exactly
     * these ranges — see
     * [SimpleName](https://source.android.com/docs/core/runtime/dex-format#simplename).
     */
    fun isDexNameChar(codePoint: Int): Boolean = when (codePoint) {
        in 'a'.code..'z'.code, in 'A'.code..'Z'.code, in '0'.code..'9'.code -> true
        '$'.code, '-'.code, '_'.code -> true
        in 0x00a1..0x1fff, in 0x2010..0x2027, in 0x2030..0xd7ff, in 0xe000..0xffef -> true
        in 0x10000..0x10ffff -> true
        else -> false
    }

    /**
     * Whether Kotlin can declare a type named [name]: [isDeclarable], and also a valid file name on
     * every platform, since the compiler writes each class to a file of that name. Windows rejects
     * `"`, `*`, `?` and `|` and drops a trailing space; [isDeclarable]'s DEX allowlist already
     * leaves all of them out, so the two checks agree.
     */
    private fun isDeclarableTypeName(name: String): Boolean = isDeclarable(name)

    /** The runs of letters and digits in [name] (`back\slash` -> `back`, `slash`). */
    private fun words(name: String): List<String> = name.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

    /**
     * The Kotlin name of a property, parameter or function the spec names [name]: [name] itself
     * when Kotlin can declare it ([isDeclarable]), else its words, each after the first
     * capitalized (`back\slash` -> `backSlash`, `b.ping` -> `bPing`, `new\nline` -> `newLine`), or `unnamed`
     * when it has none. The caller keeps [name] on the wire (`@SerialName`, the JSON-RPC method).
     */
    fun memberName(name: String): String {
        if (isDeclarable(name)) return name
        val words = words(name)
        if (words.isEmpty()) return "unnamed"
        return words.first() + words.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercaseChar) }
    }

    private val HARD_KEYWORDS = setOf(
        "as", "break", "class", "continue", "do", "else", "false", "for",
        "fun", "if", "in", "interface", "is", "null", "object", "package",
        "return", "super", "this", "throw", "true", "try", "typealias",
        "typeof", "val", "var", "when", "while",
    )

    fun isKotlinKeyword(name: String): Boolean = name in HARD_KEYWORDS

    /**
     * The type a binding's `export` resolves to. Only each segment's first character is
     * raised, so an acronym the declaring package exports as `URL` is imported as `URL`;
     * [toPascalCase] would lower its tail and name a type the package does not export.
     *
     * The empty-segment arm is defensive: the parser's `EXPORT` regex admits no dangling or
     * doubled separator, so no value reaching here splits into one.
     */
    fun exportTypeName(export: String): String =
        export.split('-', '_', '.')
            .joinToString("") { if (it.isEmpty()) "" else it[0].uppercaseChar() + it.substring(1) }

    /**
     * [name] in PascalCase, split at `_` and `-`. A result Kotlin can't declare as a type
     * ([isDeclarableTypeName]: `Back\slash`, `A.b`, `Cre"ate`, an empty name) is built from [name]'s words instead (`BackSlash`, `AB`),
     * or is `Unnamed` when [name] has none.
     */
    fun toPascalCase(name: String): String {
        val pascal = pascalCase(name.split(Regex("[_\\-]")))
        if (isDeclarableTypeName(pascal)) return pascal
        return pascalCase(words(name)).ifEmpty { "Unnamed" }
    }

    private fun pascalCase(segments: List<String>): String =
        segments
            .joinToString("") { segment ->
                if (segment.isEmpty()) ""
                else if (segment.all { it.isUpperCase() || it.isDigit() }) {
                    segment[0].uppercaseChar() + segment.substring(1).lowercase()
                } else {
                    segment[0].uppercaseChar() + segment.substring(1)
                }
            }
            .let { result ->
                if (result.isEmpty()) result
                else result[0].uppercaseChar() + result.substring(1)
            }

    fun toCamelCase(name: String): String {
        val pascal = toPascalCase(name)
        return if (pascal.isEmpty()) pascal else pascal[0].lowercaseChar() + pascal.substring(1)
    }

    /**
     * Distinct Kotlin names for [names], the spec names declared in one Kotlin scope, in order.
     * [candidate] gives the Kotlin name each would like. A name whose candidate is the name itself
     * claims it first; every other one (a name that had to change, or a later duplicate) then gets
     * its candidate, or `_2`, `_3`, … when that is taken or [reserved]. A name that collides with
     * nothing keeps its candidate.
     */
    fun allocate(names: List<String>, reserved: Set<String> = emptySet(), candidate: (String) -> String): List<String> {
        val taken = reserved.toMutableSet()
        val wanted = names.map(candidate)
        val result = arrayOfNulls<String>(names.size)
        names.forEachIndexed { i, name ->
            if (wanted[i] == name && taken.add(name)) result[i] = name
        }
        names.indices.forEach { i -> if (result[i] == null) result[i] = claim(wanted[i], taken) }
        return result.map { it!! }
    }

    /**
     * The names of the types the generator nests in a class whose properties are [propertyNames]
     * (an open record's serializer and fields class, `[OpenRecordSerializer, OpenRecordFields]`),
     * given as [generated]: each keeps its name unless a property has it, since Kotlin rejects a
     * property and a nested class of one name; then it gets `_2`, ….
     */
    fun nestedTypeNamesBeside(propertyNames: Collection<String>, generated: List<String>): List<String> {
        val taken = propertyNames.toMutableSet()
        return generated.map { claim(it, taken) }
    }

    /** [candidate], or else `<candidate>_2`, `_3`, …: the first that isn't in [taken], which it is added to. */
    fun claim(candidate: String, taken: MutableSet<String>): String {
        if (taken.add(candidate)) return candidate
        var duplicate = 2
        while (!taken.add("${candidate}_$duplicate")) duplicate++
        return "${candidate}_$duplicate"
    }
}
