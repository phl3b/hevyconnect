import fs from 'fs';
import path from 'path';

export interface Config {
  weight: number;
  unit: 'kg' | 'lbs';
  metValue: number;
  restTime: number;
  exerciseTime: number;
}

const DEFAULT_CONFIG: Config = {
  weight: 70,
  unit: 'kg',
  metValue: 5.0,
  restTime: 60,
  exerciseTime: 60,
};

/**
 * Load configuration from public/config.json
 * Returns default config if file is missing or invalid
 */
export function loadConfig(): Config {
  try {
    const configPath = path.join(process.cwd(), 'public', 'config.json');
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent) as Partial<Config>;

    // Validate and merge with defaults
    const validatedConfig: Config = {
      weight: typeof config.weight === 'number' && config.weight > 0 ? config.weight : DEFAULT_CONFIG.weight,
      unit: config.unit === 'kg' || config.unit === 'lbs' ? config.unit : DEFAULT_CONFIG.unit,
      metValue: typeof config.metValue === 'number' && config.metValue > 0 ? config.metValue : DEFAULT_CONFIG.metValue,
      restTime: typeof config.restTime === 'number' && config.restTime >= 0 ? config.restTime : DEFAULT_CONFIG.restTime,
      exerciseTime: typeof config.exerciseTime === 'number' && config.exerciseTime > 0 ? config.exerciseTime : DEFAULT_CONFIG.exerciseTime,
    };

    return validatedConfig;
  } catch (error) {
    console.warn('Failed to load config.json, using defaults:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * Convert weight to kilograms
 * @param weight - Weight value
 * @param unit - Unit of measurement ('kg' or 'lbs')
 * @returns Weight in kilograms
 */
export function convertWeightToKg(weight: number, unit: 'kg' | 'lbs'): number {
  if (unit === 'lbs') {
    // 1 lb = 0.453592 kg
    return weight * 0.453592;
  }
  return weight;
}

