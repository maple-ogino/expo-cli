import { AndroidConfig, ExpoConfig, getConfig, getPackageJson, IOSConfig } from '@expo/config';
import plist from '@expo/plist';
import { UserManager } from '@expo/xdl';
import chalk from 'chalk';
import figures from 'figures';
import * as fs from 'fs-extra';
import glob from 'glob';
import ora from 'ora';
import path from 'path';
import xcode from 'xcode';

import { gitAddAsync } from '../../../git';
import log from '../../../log';
import * as gitUtils from './git';

const iOSBuildScript = '../node_modules/expo-updates/scripts/create-manifest-ios.sh';
const androidBuildScript =
  'apply from: "../../node_modules/expo-updates/scripts/create-manifest-android.gradle"';

export async function configureUpdatesAsync({
  projectDir,
  nonInteractive,
}: {
  projectDir: string;
  nonInteractive: boolean;
}) {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return;
  }

  const spinner = ora('Configuring expo-updates');

  try {
    const { exp, username } = await getConfigurationOptionsAsync(projectDir);

    await configureUpdatesAndroidAsync(projectDir, exp, username);
    await configureUpdatesIOSAsync(projectDir, exp, username);

    await gitUtils.ensureGitStatusIsCleanAsync();

    spinner.succeed();
  } catch (err) {
    if (err instanceof gitUtils.DirtyGitTreeError) {
      spinner.succeed(`We configured expo-updates in your project`);
      log.newLine();

      try {
        await gitUtils.reviewAndCommitChangesAsync(`Configure expo-updates`, { nonInteractive });

        log(`${chalk.green(figures.tick)} Successfully committed the configuration changes.`);
      } catch (e) {
        throw new Error(
          "Aborting, run the command again once you're ready. Make sure to commit any changes you've made."
        );
      }
    } else {
      spinner.fail();
      throw err;
    }
  }
}

export async function setUpdateVersionsAsync({
  projectDir,
  nonInteractive,
}: {
  projectDir: string;
  nonInteractive: boolean;
}) {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return;
  }

  const spinner = ora('Setting runtime version for expo-updates');

  try {
    const { exp } = await getConfigurationOptionsAsync(projectDir);

    await setVersionsAndroidAsync(projectDir, exp);
    await setVersionsIOSAsync(projectDir, exp);

    await gitUtils.ensureGitStatusIsCleanAsync();

    spinner.succeed();
  } catch (err) {
    if (err instanceof gitUtils.DirtyGitTreeError) {
      spinner.succeed(`We set runtime version for expo-updates in your project`);
      log.newLine();

      try {
        await gitUtils.reviewAndCommitChangesAsync(`Set runtime version for expo-updates`, {
          nonInteractive,
        });

        log(`${chalk.green(figures.tick)} Successfully committed the configuration changes.`);
      } catch (e) {
        throw new Error(
          "Aborting, run the command again once you're ready. Make sure to commit any changes you've made."
        );
      }
    } else {
      spinner.fail();
      throw err;
    }
  }
}

async function getConfigurationOptionsAsync(
  projectDir: string
): Promise<{ exp: ExpoConfig; username: string | null }> {
  const username = await UserManager.getCurrentUsernameAsync();

  const { exp } = getConfig(projectDir, { skipSDKVersionRequirement: true });

  if (!exp.runtimeVersion && !exp.sdkVersion) {
    throw new Error(
      "Couldn't find either 'runtimeVersion' or 'sdkVersion' to configure 'expo-updates'. Please specify at least one of these properties under the 'expo' key in 'app.json'"
    );
  }

  return { exp, username };
}

function isExpoUpdatesInstalled(projectDir: string) {
  const packageJson = getPackageJson(projectDir);

  return packageJson.dependencies && 'expo-updates' in packageJson.dependencies;
}

async function configureUpdatesIOSAsync(
  projectDir: string,
  exp: ExpoConfig,
  username: string | null
) {
  const pbxprojPath = await getPbxprojPathAsync(projectDir);
  const project = await getXcodeProjectAsync(pbxprojPath);
  const bundleReactNative = await getBundleReactNativePhaseAsync(project);

  if (!bundleReactNative.shellScript.includes(iOSBuildScript)) {
    bundleReactNative.shellScript = `${bundleReactNative.shellScript.replace(
      /"$/,
      ''
    )}${iOSBuildScript}\\n"`;
  }

  await fs.writeFile(pbxprojPath, project.writeSync());

  await modifyExpoPlistAsync(projectDir, expoPlist => {
    return IOSConfig.Updates.setUpdatesConfig(exp, expoPlist, username);
  });
}

async function setVersionsIOSAsync(projectDir: string, exp: ExpoConfig) {
  await modifyExpoPlistAsync(projectDir, expoPlist => {
    const runtimeVersion = IOSConfig.Updates.getRuntimeVersion(exp);
    const sdkVersion = IOSConfig.Updates.getSDKVersion(exp);

    if (
      (runtimeVersion && expoPlist[IOSConfig.Updates.Config.RUNTIME_VERSION] === runtimeVersion) ||
      (sdkVersion && expoPlist[IOSConfig.Updates.Config.SDK_VERSION] === sdkVersion)
    ) {
      return expoPlist;
    }

    return IOSConfig.Updates.setVersionsConfig(exp, expoPlist);
  });
}

async function modifyExpoPlistAsync(projectDir: string, callback: (expoPlist: any) => any) {
  const pbxprojPath = await getPbxprojPathAsync(projectDir);
  const expoPlistPath = getExpoPlistPath(projectDir, pbxprojPath);

  let expoPlist = {};

  if (await fs.pathExists(expoPlistPath)) {
    const expoPlistContent = await fs.readFile(expoPlistPath, 'utf8');
    expoPlist = plist.parse(expoPlistContent);
  }

  const updatedExpoPlist = callback(expoPlist);

  if (updatedExpoPlist === expoPlist) {
    return;
  }

  const expoPlistContent = plist.build(updatedExpoPlist);

  await fs.mkdirp(path.dirname(expoPlistPath));
  await fs.writeFile(expoPlistPath, expoPlistContent);
  await gitAddAsync(expoPlistPath, { intentToAdd: true });
}

export async function isUpdatesConfiguredIOSAsync(projectDir: string) {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return true;
  }

  const { exp, username } = await getConfigurationOptionsAsync(projectDir);

  const pbxprojPath = await getPbxprojPathAsync(projectDir);
  const project = await getXcodeProjectAsync(pbxprojPath);
  const bundleReactNative = await getBundleReactNativePhaseAsync(project);

  if (!bundleReactNative.shellScript.includes(iOSBuildScript)) {
    return false;
  }

  const expoPlistPath = getExpoPlistPath(projectDir, pbxprojPath);

  if (!(await fs.pathExists(expoPlistPath))) {
    return false;
  }

  const expoPlist = await fs.readFile(expoPlistPath, 'utf8');
  const expoPlistData = plist.parse(expoPlist);

  return isMetadataSetIOS(expoPlistData, exp, username);
}

function isMetadataSetIOS(expoPlistData: any, exp: ExpoConfig, username: string | null) {
  const currentUpdateUrl = IOSConfig.Updates.getUpdateUrl(exp, username);

  if (
    isVersionsSetIOS(expoPlistData) &&
    currentUpdateUrl &&
    expoPlistData[IOSConfig.Updates.Config.UPDATE_URL] === currentUpdateUrl
  ) {
    return true;
  }

  return false;
}

function isVersionsSetIOS(expoPlistData: any) {
  if (
    expoPlistData[IOSConfig.Updates.Config.RUNTIME_VERSION] ||
    expoPlistData[IOSConfig.Updates.Config.SDK_VERSION]
  ) {
    return true;
  }

  return false;
}

async function getPbxprojPathAsync(projectDir: string) {
  const pbxprojPaths = await new Promise<string[]>((resolve, reject) =>
    glob('ios/*/project.pbxproj', { absolute: true, cwd: projectDir }, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    })
  );

  const pbxprojPath = pbxprojPaths.length > 0 ? pbxprojPaths[0] : undefined;

  if (!pbxprojPath) {
    throw new Error(`Could not find Xcode project in project directory: "${projectDir}"`);
  }

  return pbxprojPath;
}

async function getXcodeProjectAsync(pbxprojPath: string) {
  const project = xcode.project(pbxprojPath);

  await new Promise((resolve, reject) =>
    project.parse(err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    })
  );

  return project;
}

function getExpoPlistPath(projectDir: string, pbxprojPath: string) {
  const xcodeprojPath = path.resolve(pbxprojPath, '..');
  const expoPlistPath = path.resolve(
    projectDir,
    'ios',
    path.basename(xcodeprojPath).replace(/\.xcodeproj$/, ''),
    'Supporting',
    'Expo.plist'
  );

  return expoPlistPath;
}

async function getBundleReactNativePhaseAsync(project: xcode.XcodeProject) {
  const scriptBuildPhase = project.hash.project.objects.PBXShellScriptBuildPhase;
  const bundleReactNative = Object.values(scriptBuildPhase).find(
    buildPhase => buildPhase.name === '"Bundle React Native code and images"'
  );

  if (!bundleReactNative) {
    throw new Error(`Couldn't find a build phase script for "Bundle React Native code and images"`);
  }

  return bundleReactNative;
}

async function configureUpdatesAndroidAsync(
  projectDir: string,
  exp: ExpoConfig,
  username: string | null
) {
  const buildGradlePath = getAndroidBuildGradlePath(projectDir);
  const buildGradleContent = await getAndroidBuildGradleContentAsync(buildGradlePath);

  if (!hasBuildScriptApply(buildGradleContent)) {
    await fs.writeFile(
      buildGradlePath,
      `${buildGradleContent}\n// Integration with Expo updates\n${androidBuildScript}\n`
    );
  }

  const {
    path: androidManifestPath,
    data: androidManifestJSON,
  } = await getAndroidManifestJSONAsync(projectDir);

  if (!isMetadataSetAndroid(androidManifestJSON, exp, username)) {
    const result = await AndroidConfig.Updates.setUpdatesConfig(exp, androidManifestJSON, username);

    await AndroidConfig.Manifest.writeAndroidManifestAsync(androidManifestPath, result);
  }
}

async function setVersionsAndroidAsync(projectDir: string, exp: ExpoConfig) {
  const {
    path: androidManifestPath,
    data: androidManifestJSON,
  } = await getAndroidManifestJSONAsync(projectDir);
  const runtimeVersion = AndroidConfig.Updates.getRuntimeVersion(exp);
  const sdkVersion = AndroidConfig.Updates.getSDKVersion(exp);

  const setRuntimeVersion = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.RUNTIME_VERSION
  );

  const setSdkVersion = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.SDK_VERSION
  );

  if (
    (runtimeVersion && runtimeVersion === setRuntimeVersion) ||
    (sdkVersion && sdkVersion === setSdkVersion)
  ) {
    return;
  }

  const result = await AndroidConfig.Updates.setVersionsConfig(exp, androidManifestJSON);

  await AndroidConfig.Manifest.writeAndroidManifestAsync(androidManifestPath, result);
}

export async function isUpdatesConfiguredAndroidAsync(projectDir: string) {
  if (!isExpoUpdatesInstalled(projectDir)) {
    return true;
  }

  const { exp, username } = await getConfigurationOptionsAsync(projectDir);

  const buildGradlePath = getAndroidBuildGradlePath(projectDir);
  const buildGradleContent = await getAndroidBuildGradleContentAsync(buildGradlePath);

  if (!hasBuildScriptApply(buildGradleContent)) {
    return false;
  }

  const { data: androidManifestJSON } = await getAndroidManifestJSONAsync(projectDir);

  if (!isMetadataSetAndroid(androidManifestJSON, exp, username)) {
    return false;
  }

  return true;
}

function getAndroidBuildGradlePath(projectDir: string) {
  const buildGradlePath = path.join(projectDir, 'android', 'app', 'build.gradle');

  return buildGradlePath;
}

async function getAndroidBuildGradleContentAsync(buildGradlePath: string) {
  if (!(await fs.pathExists(buildGradlePath))) {
    throw new Error(`Couldn't find gradle build script at ${buildGradlePath}`);
  }

  const buildGradleContent = await fs.readFile(buildGradlePath, 'utf-8');

  return buildGradleContent;
}

function hasBuildScriptApply(buildGradleContent: string): boolean {
  return (
    buildGradleContent
      .split('\n')
      // Check for both single and double quotes
      .some(line => line === androidBuildScript || line === androidBuildScript.replace(/"/g, "'"))
  );
}

async function getAndroidManifestJSONAsync(projectDir: string) {
  const androidManifestPath = await AndroidConfig.Manifest.getProjectAndroidManifestPathAsync(
    projectDir
  );

  if (!androidManifestPath) {
    throw new Error(`Could not find AndroidManifest.xml in project directory: "${projectDir}"`);
  }

  const androidManifestJSON = await AndroidConfig.Manifest.readAndroidManifestAsync(
    androidManifestPath
  );

  return {
    path: androidManifestPath,
    data: androidManifestJSON,
  };
}

function isMetadataSetAndroid(
  androidManifestJSON: AndroidConfig.Manifest.Document,
  exp: ExpoConfig,
  username: string | null
): boolean {
  const currentUpdateUrl = AndroidConfig.Updates.getUpdateUrl(exp, username);

  const setUpdateUrl = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.UPDATE_URL
  );

  return Boolean(
    isVersionsSetAndroid(androidManifestJSON) &&
      currentUpdateUrl &&
      setUpdateUrl === currentUpdateUrl
  );
}

function isVersionsSetAndroid(androidManifestJSON: AndroidConfig.Manifest.Document): boolean {
  const runtimeVersion = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.RUNTIME_VERSION
  );

  const sdkVersion = getAndroidMetadataValue(
    androidManifestJSON,
    AndroidConfig.Updates.Config.SDK_VERSION
  );

  return Boolean(runtimeVersion || sdkVersion);
}

function getAndroidMetadataValue(
  androidManifestJSON: AndroidConfig.Manifest.Document,
  name: string
): string | undefined {
  const mainApplication = androidManifestJSON.manifest.application.filter(
    (e: any) => e['$']['android:name'] === '.MainApplication'
  )[0];

  if (mainApplication.hasOwnProperty('meta-data')) {
    const item = mainApplication['meta-data'].find((e: any) => e.$['android:name'] === name);

    return item?.$['android:value'];
  }

  return undefined;
}
