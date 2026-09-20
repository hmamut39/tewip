// Deterministic readers for mobile test failures that are about the device, not the app: no
// emulator or simulator, the app never installed or crashed on launch, the driver could not be
// reached, the test sandbox could not be built. These are environment problems, the same kind as a
// refused connection, and they say nothing about the code under test.
// Checked against real messages pasted into public issues (Appium, Espresso, Detox, XCUITest,
// xcodebuild, Robolectric); every pattern below came from one of them.

export interface DeviceSignal {
  kind: 'no-device' | 'app-crashed' | 'install-failed' | 'driver-unreachable' | 'sandbox';
  /** The text that triggered the signal, for the evidence line. */
  match: string;
  confidence: number;
}

const DEVICE_PATTERNS: Array<{ kind: DeviceSignal['kind']; confidence: number; pattern: RegExp }> = [
  // No device or simulator to run on: Appium, Flutter, Maestro, xcodebuild.
  {
    kind: 'no-device',
    confidence: 0.9,
    pattern:
      /Could not find a connected (?:Android|iOS) device[^\n]*|Device \S+ was not in the list of connected devices|No connected devices|Unable to boot the Simulator|Failed to prepare device [^\n]*for impending launch|no devices found|adb: device offline|device unauthorized|An unknown server-side error occurred[^\n]*Could not find a \w+ device/i,
  },
  // The app under test never started, or died during the run.
  {
    kind: 'app-crashed',
    confidence: 0.85,
    pattern: /The application under test with bundle id [^\n]*is not running, possibly crashed|WDAError\(status=889[^\n]*|your main activity has crashed prematurely|Application is not running, possibly crashed|instrumentation process (?:crashed|is not responding)/i,
  },
  // The build or test runner could not be put on the device.
  {
    kind: 'install-failed',
    confidence: 0.85,
    pattern: /Failed to install or launch the test runner|INSTALL_FAILED_\w+|Failed to run application on the device|Could not install [^\n]*apk|Unable to install [^\n]*\.app/i,
  },
  // The automation server itself is unreachable (Appium, WebDriverAgent).
  { kind: 'driver-unreachable', confidence: 0.85, pattern: /Failed to connect to the appium server[^\n]*|Could not proxy command to the remote server|WebDriverAgent[^\n]*(?:failed to start|is not reachable)/i },
  // The test sandbox could not be built at all: a toolchain mismatch, not a test failure.
  { kind: 'sandbox', confidence: 0.9, pattern: /Failed to create a Robolectric sandbox[^\n]*|Android SDK \d+ requires Java \d+ \(have Java \d+\)/i },
];

/**
 * A mobile failure caused by the device, the install or the driver, strongest first. Detox prints
 * the same error for a crash and for a test timeout, telling them apart only in its HINT line, so
 * that line decides: a timed-out test is the test's problem and gets no device signal here.
 */
export function deviceEnvSignal(message: string): DeviceSignal | null {
  if (/your tests have timed out and called detox\.cleanup\(\)/i.test(message)) return null;
  for (const { kind, confidence, pattern } of DEVICE_PATTERNS) {
    const match = message.match(pattern)?.[0];
    if (match) return { kind, confidence, match: match.replace(/\s+/g, ' ').trim().slice(0, 160) };
  }
  return null;
}
