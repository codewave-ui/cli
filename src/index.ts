#! /usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import yargs from 'yargs';
import { glob } from 'glob';
import {
  Assert,
  assertIsError,
  convertTimeMillisToPrettyString,
  Driver,
  EventFactory,
  EventType,
  Keyword,
  Platform,
  Runner,
  TestStatus,
} from '@codewave-ui/core';
import { DateTime } from 'luxon';

function assertPlaformCorrect(platform: string): asserts platform is Platform {
  if (
    !(
      platform === Platform.WEB_DESKTOP.toString() ||
      platform === Platform.WEB_LITE.toString() ||
      platform === Platform.MOBILE_ANDROID.toString() ||
      platform === Platform.MOBILE_IOS.toString()
    )
  ) {
    throw new Error('[ERR0002] Platform is not valid!');
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
          tc: {
            alias: 'test-case',
            demandOption: false,
            describe: 'Test case name',
            type: 'string',
          },
        });
      },
      async function (argv) {
        const testCase = argv.tc as string | undefined;
        // Load all test files specified in the cli arguments
        let fileGlobPath: string = <string>argv.name_or_path;
        if (process.platform === 'win32') fileGlobPath = fileGlobPath.replaceAll('\\', '/');
        const files = await glob(fileGlobPath, {
          ignore: ['node_modules/**', 'out/**'],
        });

        const platform = argv.p;
        assertPlaformCorrect(platform);
        const configFile = argv.c ? argv.c : 'codewaveui.config.js';
        let normalizeConfigFile = path.resolve(
          path.join(process.cwd(), 'out', configFile.replace('.ts', '.js')),
        );
        if (process.platform === 'win32') normalizeConfigFile = `file://${normalizeConfigFile}`;
        let parallelRun = 1;
        // Container for the runners
        const runners: (() => Promise<Runner>)[] = [];

        // Initialize and load config files
        const configModule = await import(normalizeConfigFile);
        const config = configModule.default(platform);

        for (const file of files) {
          let normalizeFile = path.resolve(
            path.join(process.cwd(), 'out', file.replace('.ts', '.js')),
          );
          if (process.platform === 'win32') normalizeFile = `file://${normalizeFile}`;

          // Dynamic import the test class
          const { default: Test } = await import(normalizeFile);

          const loggerFactory = Test.loggerFactory;
          const mainLogger = loggerFactory.createLogger('MAIN');

          parallelRun = config.parallelExecution;

          // Generate event manager for this particular test class
          const eventManager = EventFactory.generateEventManager(
            loggerFactory.createLogger('EventManager'),
          );

          // Initialize runner
          const currentRunner: Runner = Test.runnerFactory.getCurrentRunner();
          const driver = new Driver(config, loggerFactory.createLogger('Driver'));

          // Initialize driver
          await driver.startDriver();

          // Initialize keyword instances
          const keyword = new Keyword(
            driver,
            currentRunner,
            loggerFactory.createLogger('Keyword'),
            config,
            eventManager,
          );

          // Initialize assertion instances
          const assertion = new Assert(
            driver,
            currentRunner,
            loggerFactory.createLogger('Keyword'),
            config,
            eventManager,
          );

          // Create test instance from the config
          const test = new Test(
            config,
            loggerFactory.createLogger(currentRunner.name),
            eventManager,
            currentRunner,
          );

          // Initialize test listeners
          for (const Listener of config.listeners) {
            // Create test listener instance
            new Listener(
              eventManager,
              loggerFactory.createLogger(Listener.constructor.name),
              currentRunner,
            );
          }

          // For Test Case Run Only
          if (testCase) {
            currentRunner.testCases = currentRunner.testCases.filter(
              tc => tc.name === testCase || tc.id === testCase,
            );
          }

          // Generate runner main function
          runners.push(async (): Promise<Runner> => {
            currentRunner.startNow();

            // Try invoke before test suite hook
            try {
              await eventManager.emitSerial(EventType.BEFORE_SUITE, {
                testSuiteName: test.testSuiteName,
                testSuiteId: test.testSuiteId,
                runner: currentRunner,
                Keyword: keyword,
                logFolder: loggerFactory.logFolder,
              });
            } catch (err) {
              assertIsError(err);
              // If error update runner and stop execution
              mainLogger.error(`${err.message}\n${err.stack}`);
              currentRunner.endNow();
              currentRunner.generateDuration();
              return currentRunner;
            }

            // For each test cases in the test suites
            for (const [index, runner] of currentRunner.testCases.entries()) {
              currentRunner.currentTestCaseIndex = index;
              // Check if the test case is disabled or not
              if (runner.enabled) {
                await driver.startDriver();
                try {
                  // Try to invoke before test case hook
                  await eventManager.emitSerial(EventType.BEFORE_CASE, {
                    testSuiteName: test.testSuiteName,
                    testSuiteId: test.testSuiteId,
                    runner: currentRunner,
                    Keyword: keyword,
                    logFolder: loggerFactory.logFolder,
                  });

                  try {
                    // Try to run the test case
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].startNow();
                    await runner.method.bind(test)({ Keyword: keyword, Assertion: assertion });
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].markAsPassed();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].endNow();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].generateDuration();
                    if (currentRunner.status === TestStatus.SKIPPED) currentRunner.markAsPassed();
                  } catch (tcError) {
                    assertIsError(tcError);
                    currentRunner.markAsFailed();
                    const now = DateTime.now().toMillis();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].endNow();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].generateDuration();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].markAsFailed();
                    currentRunner.testCases[currentRunner.currentTestCaseIndex].exception =
                      tcError.message;

                    // Try to take screenshot
                    try {
                      const ssPath = path.resolve(path.join(loggerFactory.logFolder, now + '.png'));
                      await driver.getDriverInstance().saveScreenshot(ssPath);
                      currentRunner.testCases[currentRunner.currentTestCaseIndex].screenshot =
                        ssPath;
                    } catch (ssError) {
                      assertIsError(ssError);
                      // Ignore and warn if failed to take screenshot
                      mainLogger.warn(`${ssError.message}\n${ssError.stack}`);
                    }
                    currentRunner.markAsFailed();
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
                  await eventManager.emitSerial(EventType.AFTER_CASE, {
                    testSuiteName: test.testSuiteName,
                    testSuiteId: test.testSuiteId,
                    runner: currentRunner,
                    Keyword: keyword,
                    logFolder: loggerFactory.logFolder,
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
              await eventManager.emitSerial(EventType.AFTER_SUITE, {
                testSuiteName: test.testSuiteName,
                testSuiteId: test.testSuiteId,
                runner: currentRunner,
                Keyword: keyword,
                logFolder: loggerFactory.logFolder,
              });
            } catch (err) {
              assertIsError(err);
              mainLogger.error(`${err.message}\n${err.stack}`);
            }
            return currentRunner;
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
