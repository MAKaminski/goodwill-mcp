import type { Command } from '../registry.js';
import { intakeOpen } from './intake.js';
import { donationCreate, donationUpdate, donationReport } from './donation.js';
import { valuationShow } from './valuation.js';

/** The one registry. MCP tools, CLI commands and the README table all come from this list. */
export const commands: Command<any>[] = [intakeOpen, donationCreate, donationUpdate, donationReport, valuationShow];
