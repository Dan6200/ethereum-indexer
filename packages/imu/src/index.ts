#!/usr/bin/env node
import { Command } from 'commander';
import { rollbackCommand } from './commands/rollback';

const program = new Command();

program
  .name('imu')
  .description('Indexer Management Utility - Maintenance tools for the Custom Ethereum Indexer')
  .version('1.0.0');

program.addCommand(rollbackCommand);

program.parse(process.argv);
