# 安卓本地构建备忘（Windows 本机）

批次 1 起真机/模拟器验证用 release APK（自包含 JS bundle，不需要 Metro 开发服务器）。
构建环境在本机一次性配好后，后续批次只需最后一条命令。

## 本机构建环境（2026-09-01 配好）

| 项 | 位置 |
|---|---|
| Android SDK | `C:\Users\Lathan\AppData\Local\Android\Sdk`（platform 36 + build-tools 36.1.0，许可已接受） |
| Gradle 运行时 JDK 21 | `D:\software\Android Studio\jbr`（设为 JAVA_HOME） |
| Java 17 工具链 | `D:\software\jdk-17.0.20.1+1`（Temurin，清华 Adoptium 镜像下载；另复制了一份到 `~/.gradle/jdks/`） |
| Gradle 发行版镜像 | 华为云（写在 `android/gradle/wrapper/gradle-wrapper.properties`，`services.gradle.org` 国内超时） |
| 模拟器 | AVD `Small_Phone`（WHPX 加速），插件工具 `android_start_emulator` 启动 |

## 生成原生工程（仅首次 / Expo SDK 升级后）

```sh
npx expo prebuild -p android --no-install
echo "sdk.dir=C:/Users/Lathan/AppData/Local/Android/Sdk" > android/local.properties
# 并把 gradle-wrapper.properties 的 distributionUrl 改成华为云镜像（见上）
```

`android/` 在 .gitignore 里（CNG 流程，不进版本库），**prebuild 重新生成会丢掉下面两个改动，需重做**。

## 构建 release APK

```sh
cd android
export JAVA_HOME="/d/software/Android Studio/jbr"
./gradlew assembleRelease --console=plain \
  -Dorg.gradle.java.installations.paths="D:/software/jdk-17.0.20.1+1" \
  -Dorg.gradle.java.installations.auto-download=false
# 产物：android/app/build/outputs/apk/release/app-release.apk（约 66MB）
```

两个 `-D` 必须**放命令行**，不能写进 `android/gradle.properties`：
expo/rn 的 Gradle 插件是 includeBuild 复合构建，子构建读不到根构建的
gradle.properties，只看得到守护进程 JVM 的系统属性。第二个参数关掉
foojay 自动下载——否则它从 GitHub 拉 JDK 17，国内会挂死十分钟以上。

## 装进模拟器

用安卓模拟器插件的 `android_install_app`（apkPath 指向上面 APK）+
`android_launch_app`（applicationId `com.lathan.openprism`），或者直接
`adb install -r <apk>`。模拟器窗口在桌面可见，可直接上手操作。

## 已知限制

- `adb shell input text` 不支持中文（NPE），自动化测试里输入用 ASCII。
- 首次构建约 16 分钟（下载 AGP/androidx 依赖）；之后增量构建分钟级。
