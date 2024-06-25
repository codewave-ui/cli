#! /usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import yargs from 'yargs';
import { glob } from 'glob';
import {
  BaseConfig,
  convertTimeMillisToPrettyString,
  DesktopConfigs,
  EventFactory,
  EventType,
  Platform,
  TestStatus,
  WebDriver,
} from '@codewave-ui/core';
import { DateTime } from 'luxon';

function assertIsError(error: unknown): asserts error is Error {
  // if you have nodejs assert:
  // assert(error instanceof Error);
  // otherwise
  if (!(error instanceof Error)) {
    throw error;
  }
}

(async () => {
  await yargs(process.argv.slice(2))
    .scriptName('codewave-ui')
    .version('0.0.1')
    .usage('$0 <cmd> [args]')
    .command(
      'test-suite <name_or_path> [options]',
      'run codewave-ui test suite',
      yargs => {
        yargs.positional('name_or_path', {
          type: 'string',
          default: '',
          demandOption: false,
          describe: 'Test suite name or path',
        });
        return yargs.options({
          p: {
            alias: 'platform',
            demandOption: true,
            describe: 'platform to run the test [desktop, lite, android, ios]',
            type: 'string',
            default: 'desktop',
          },
          c: {
            alias: 'config',
            demandOption: false,
            describe: 'location of the config files',
            type: 'string',
          },
        });
      },
      async function (argv) {
        // Load all test files specified in the cli arguments
        const files = await glob(<string>argv.name_or_path, {
          ignore: ['node_modules/**', 'out/**'],
        });
        const listeners = await glob('src/listeners/**/*.ts', {
          ignore: 'src/listeners/base.listener.ts',
        });

        const platform = argv.p as unknown as Platform;
        const configFile = argv.c as string;
        let parallelRun = 1;

        // Container for the runners
        const runners: (() => Promise<void>)[] = [];

        for (const file of files) {
          let normalizeFile = path.resolve(
            path.join(process.cwd(), 'out', file.replace('.ts', '.js')),
          );
          if (process.platform === 'win32') normalizeFile = `file://${normalizeFile}`;

          // Dynamic import the test class
          const { default: Test } = await import(normalizeFile);

          const loggerFactory = Test.loggerFactory;
          const mainLogger = loggerFactory.createLogger('MAIN');

          // Initialize and load config files
          let config: BaseConfig;
          let keywordName: string;
          switch (platform) {
            case Platform.WEB_LITE:
              // TODO initialize lite config
              config = new DesktopConfigs(loggerFactory.createLogger('Config'));
              keywordName = 'WebKeyword';

              break;
            case Platform.MOBILE_ANDROID:
              // TODO initialize lite config
              config = new DesktopConfigs(loggerFactory.createLogger('Config'));
              keywordName = 'WebKeyword';

              break;
            case Platform.MOBILE_IOS:
              // TODO initialize lite config
              config = new DesktopConfigs(loggerFactory.createLogger('Config'));
              keywordName = 'WebKeyword';

              break;
            default:
              config = new DesktopConfigs(loggerFactory.createLogger('Config'));
              keywordName = 'WebKeyword';
          }
          config.loadFromFile(configFile);

          parallelRun = config.parallelExecution;

          // Create test instance from the config
          const test = new Test(config);

          // Generate event manager for this particular test class
          const eventManager = EventFactory.generateEventManager(
            loggerFactory.createLogger('EventManager'),
          );

          // Initialize test listeners
          for (const listener of listeners) {
            let normalizeListener = path.resolve(
              path.join(process.cwd(), 'out', listener.replace('.ts', '.js')),
            );
            if (process.platform === 'win32') normalizeListener = `file://${normalizeListener}`;

            // Dynamic import the listener class
            const { default: TestListener } = await import(normalizeListener);

            // Create test listener instance
            new TestListener(eventManager);
          }

          const currentRunner = Test.runnerFactory.getCurrentRunner();
          const driverLogger = loggerFactory.createLogger('Driver');
          const keywordLogger = loggerFactory.createLogger(keywordName);

          // Generate runner main function
          runners.push(async () => {
            currentRunner.startNow();

            // Try invoke before test suite hook
            try {
              await eventManager.emit(EventType.BEFORE_SUITE, {
                testSuiteName: test.testSuiteName,
                testSuiteId: test.testSuiteId,
                runner: currentRunner,
              });
            } catch (err) {
              assertIsError(err);
              // If error update runner and stop execution
              mainLogger.error(`${err.message}\n${err.stack}`);
              currentRunner.endNow();
              currentRunner.generateDuration();
              return;
            }

            // For each test cases in the test suites
            for (const [index, runner] of currentRunner.testCases.entries()) {
              currentRunner.currentTestCaseIndex = index;
              // Check if the test case is disabled or not
              if (runner.enabled) {
                // Initialize driver
                const driver = new WebDriver(config, driverLogger, keywordLogger, currentRunner);
                await driver.startDriver();

                try {
                  // Try to invoke before test case hook
                  await eventManager.emit(EventType.BEFORE_CASE, {
                    testSuiteName: test.testSuiteName,
                    testSuiteId: test.testSuiteId,
                    runner: currentRunner,
                  });

                  try {
                    // Try to run the test case
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].startNow();
                    await runner.method.bind(test)({ driver });
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].status =
                      TestStatus.SUCCESS;
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].endNow();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].generateDuration();
                  } catch (tcError) {
                    assertIsError(tcError);
                    const now = DateTime.now().toMillis();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].endNow();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].generateDuration();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].status =
                      TestStatus.FAILED;
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].exception =
                      tcError.message;

                    // Try to take screenshot
                    try {
                      const ssPath = path.resolve(path.join(loggerFactory.logFolder, now + '.png'));
                      await driver.driver.saveScreenshot(ssPath);
                      currentRunner.testCases[currentRunner.currentTestCaseIndex].screenshot =
                        ssPath;
                    } catch (ssError) {
                      assertIsError(ssError);
                      // Ignore and warn if failed to take screenshot
                      mainLogger.warn(`${ssError.message}\n${ssError.stack}`);
                    }
                    currentRunner.status = TestStatus.FAILED;
                    mainLogger.error(`${tcError.message}\n${tcError.stack}`);
                  }
                } catch (btcError) {
                  assertIsError(btcError);
                  //If error on before test case hook update runner and don't run the test case
                  mainLogger.error(`${btcError.message}\n${btcError.stack}`);
                  currentRunner.testCases[currentRunner.currentTestCaseIndex].duration =
                    convertTimeMillisToPrettyString(0);
                  await driver.destroyDriver();
                }

                // Try to invoke after test case hook
                try {
                  await eventManager.emit(EventType.AFTER_CASE, {
                    testSuiteName: test.testSuiteName,
                    testSuiteId: test.testSuiteId,
                    runner: currentRunner,
                  });
                } catch (atcError) {
                  assertIsError(atcError);
                  mainLogger.error(`${atcError.message}\n${atcError.stack}`);
                }

                // Finally destroy the driver
                await driver.destroyDriver();
              } else {
                mainLogger.info(
                  `Test ${currentRunner.testCases[currentRunner.currentTestCaseIndex].name} [${currentRunner.testCases[currentRunner.currentTestCaseIndex].id}] is disabled! Skipping test execution...`,
                );
              }
            }
            try {
              currentRunner.endNow();
              currentRunner.generateDuration();
              await eventManager.emit(EventType.AFTER_SUITE, {
                testSuiteName: test.testSuiteName,
                testSuiteId: test.testSuiteId,
                runner: currentRunner,
              });
            } catch (err) {
              assertIsError(err);
              mainLogger.error(`${err.message}\n${err.stack}`);
            }
          });
        }

        for (let i = 0; i < runners.length; i += parallelRun) {
          const sliceRunners = runners.slice(i, i + parallelRun);
          const promises = sliceRunners.map(runner => runner());
          const results = await Promise.allSettled(promises);
          for (const result of results) {
            if (result.status === 'rejected') {
              console.error(result.reason);
            }
          }
        }
      },
    )
    .help()
    .parse();
})();
