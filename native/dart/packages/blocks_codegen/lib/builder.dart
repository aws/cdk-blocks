// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:build/build.dart';
import 'package:pub_semver/pub_semver.dart';

import 'src/parser.dart';
import 'src/builder.dart' as codegen_builder;
import 'src/generator.dart';

/// Factory for the build_runner builder.
Builder blocksCodegenBuilder(BuilderOptions options) => _BlocksCodegenBuilder(
  options.config['fail_on_collision'] as bool? ?? false,
  ((options.config['native_package_opt_out'] as List?) ?? const [])
      .cast<String>()
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toSet(),
);

class _BlocksCodegenBuilder extends Builder {
  /// When true, collisions are a hard error instead of auto-suffixed + warned.
  final bool failOnCollision;

  /// Logical package identities, as keyed in `x-blocks-native-packages`. An
  /// undeclared identity opts nothing out and reports `AWSBLOCKS-NATIVE-006`.
  final Set<String> optedOutPackages;

  _BlocksCodegenBuilder(this.failOnCollision, this.optedOutPackages);

  @override
  final buildExtensions = const {
    '.spec.json': ['.blocks.dart'],
  };

  @override
  Future<void> build(BuildStep buildStep) async {
    final inputId = buildStep.inputId;
    final contents = await buildStep.readAsString(inputId);

    final rpcModel = const OpenRpcParser().parse(contents);
    final codegenModel = codegen_builder.CodegenModelBuilder(
      failOnCollision: failOnCollision,
      optedOutPackages: optedOutPackages,
    ).build(rpcModel);
    for (final w in codegenModel.warnings) {
      log.warning(w);
    }
    // Format for the language version of the package being built, which is
    // the one `dart format` formats the output at.
    final packageConfig = await buildStep.packageConfig;
    final version = packageConfig[inputId.package]?.languageVersion;
    final output = DartCodeGenerator(
      languageVersion: version == null
          ? null
          : Version(version.major, version.minor, 0),
    ).generate(codegenModel);

    // .spec.json → .blocks.dart (strip both extensions)
    final path = inputId.path;
    final outputPath =
        '${path.substring(0, path.length - '.spec.json'.length)}.blocks.dart';
    final outputId = AssetId(inputId.package, outputPath);
    await buildStep.writeAsString(outputId, output);
  }
}
