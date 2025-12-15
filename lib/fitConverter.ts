import { Encoder, Profile } from '@garmin/fitsdk';
import { HevyActivity } from './types';
import { findExerciseMatch } from './exerciseNameMatcher';

// FIT epoch: UTC 00:00 Dec 31 1989
const FIT_EPOCH = new Date('1989-12-31T00:00:00Z').getTime();

function dateToFitTimestamp(date: Date): number {
  // Convert to seconds since FIT epoch
  return Math.floor((date.getTime() - FIT_EPOCH) / 1000);
}

/**
 * Estimate calories burned for a strength training workout using MET method
 * MET formula: Calories = MET × weight(kg) × duration(hours)
 * 
 * @param durationSeconds - Workout duration in seconds
 * @param weightKg - User's body weight in kilograms
 * @param metValue - Metabolic Equivalent of Task value (typically 3.0-6.0 for strength training)
 * @returns Estimated calories burned (rounded to nearest integer)
 */
function estimateCaloriesMET(durationSeconds: number, weightKg: number, metValue: number): number {
  // MET formula: Calories = MET × weight(kg) × duration(hours)
  const durationHours = durationSeconds / 3600;
  const calories = metValue * weightKg * durationHours;
  
  // Round to nearest integer (calories are whole numbers)
  return Math.round(calories);
}

export async function convertActivityToFIT(
  activity: HevyActivity,
  includeSets: boolean = true,
  weightKg: number = 70,
  metValue: number = 5.0,
  restTimeSeconds: number = 60,
  exerciseTimeSeconds: number = 60
): Promise<Uint8Array> {
  const encoder = new Encoder();
  
  // Parse timestamps
  const startTime = parseHevyTimestamp(activity.start_time);
  const endTime = parseHevyTimestamp(activity.end_time);
  
  // Calculate duration correctly: End Time - Start Time
  // FIT fields with scale: 1000 and units: "s" 
  // Garmin Connect appears to read the value without applying the scale factor
  // So we store duration in seconds (not milliseconds) so Garmin Connect reads it correctly
  const durationSeconds = Math.round((endTime.getTime() - startTime.getTime()) / 1000); // Duration in seconds
  
  // Estimate calories burned for the workout using MET method
  const totalCalories = estimateCaloriesMET(durationSeconds, weightKg, metValue);

  const startTimeFit = dateToFitTimestamp(startTime);
  const endTimeFit = dateToFitTimestamp(endTime);
  
  // Calculate localTimestamp (local time offset in seconds from UTC)
  // For simplicity, use 0 (UTC) - can be adjusted if needed
  const localTimestamp = 0;

  // File ID message (mesgNum 0)
  encoder.writeMesg({
    mesgNum: 0, // fileId
    manufacturer: 1, // Garmin
    type: 4, // file.activity
    timeCreated: startTimeFit,
    serialNumber: 0,
  });

  // Device Info message (mesgNum 23) - helps Garmin Connect identify the file
  encoder.writeMesg({
    mesgNum: 23, // deviceInfo
    timestamp: startTimeFit,
    deviceIndex: 0, // creator device (0 = creator)
    manufacturer: 1, // Garmin
    product: 0,
    productName: 'Hevy Converter',
    serialNumber: 0,
    softwareVersion: 1,
  });

  // Event message (mesgNum 21) - timer start
  encoder.writeMesg({
    mesgNum: 21, // event
    timestamp: startTimeFit,
    event: 0, // event.timer
    eventType: 0, // eventType.start
  });

  // Session message (mesgNum 18)
  encoder.writeMesg({
    mesgNum: 18, // session
    messageIndex: 0,
    timestamp: endTimeFit,
    startTime: startTimeFit,
    sport: 10, // sport.training
    subSport: 20, // subSport.strengthTraining
    totalElapsedTime: durationSeconds, // End Time - Start Time in seconds (Garmin Connect reads without applying scale)
    totalTimerTime: durationSeconds,
    totalDistance: 0,
    totalCalories: totalCalories, // Estimated calories burned
    avgSpeed: 0,
    maxSpeed: 0,
    avgHeartRate: 0,
    maxHeartRate: 0,
    avgCadence: 0,
    maxCadence: 0,
    totalAscent: 0,
    totalDescent: 0,
    numLaps: 1,
    firstLapIndex: 0,
    eventGroup: 0,
  });

  // Lap message (mesgNum 19)
  encoder.writeMesg({
    mesgNum: 19, // lap
    messageIndex: 0,
    timestamp: endTimeFit,
    startTime: startTimeFit,
    totalElapsedTime: durationSeconds, // End Time - Start Time in seconds (Garmin Connect reads without applying scale)
    totalTimerTime: durationSeconds,
    totalDistance: 0,
    totalCalories: totalCalories, // Estimated calories burned
    avgSpeed: 0,
    maxSpeed: 0,
    avgHeartRate: 0,
    maxHeartRate: 0,
    avgCadence: 0,
    maxCadence: 0,
    totalAscent: 0,
    totalDescent: 0,
    eventGroup: 0,
  });

  // Activity message (mesgNum 34) - single message at end (after session/lap, before event stop)
  encoder.writeMesg({
    mesgNum: 34, // activity
    timestamp: endTimeFit,
    totalTimerTime: durationSeconds, // End Time - Start Time in seconds (Garmin Connect reads without applying scale)
    numSessions: 1,
    localTimestamp: localTimestamp,
  });

  // Event message (mesgNum 21) - timer stop
  encoder.writeMesg({
    mesgNum: 21, // event
    timestamp: endTimeFit,
    event: 0, // event.timer
    eventType: 4, // eventType.stopAll
  });

  // Write sets for each exercise (only if includeSets is true)
  if (includeSets) {
    let setIndex = 0;
    let wktStepIndex = 0;

    // Create workout step messages for each unique exercise
    // Map exercise title to workout step index
    const exerciseToWktStepIndex = new Map<string, number>();
    
    for (let exerciseIdx = 0; exerciseIdx < activity.exercises.length; exerciseIdx++) {
      const exercise = activity.exercises[exerciseIdx];
      
      // Only create workout step if we haven't seen this exercise before
      if (!exerciseToWktStepIndex.has(exercise.exercise_title)) {
        // Workout step message (mesgNum 27) for exercise
        encoder.writeMesg({
          mesgNum: 27, // workoutStep
          messageIndex: wktStepIndex,
          wktStepName: exercise.exercise_title, // Exercise name as workout step name
        });
        
        exerciseToWktStepIndex.set(exercise.exercise_title, wktStepIndex);
        wktStepIndex++;
      }
    }

    // Collect all sets with their timestamps first to calculate durations
    interface SetWithTimestamp {
      set: any;
      exerciseTitle: string; // Store exercise title as string to avoid reference issues
      exerciseIndex: number;
      setIndex: number;
      timestamp: Date;
      timestampFit: number;
      wktStepIndex: number; // Reference to workout step
    }

    const allSets: SetWithTimestamp[] = [];
    let currentTimestamp = startTime.getTime();
    const EXERCISE_TIME_MS = exerciseTimeSeconds * 1000; // Exercise time in milliseconds
    const REST_TIME_MS = restTimeSeconds * 1000; // Rest time between sets in milliseconds

    for (let exerciseIdx = 0; exerciseIdx < activity.exercises.length; exerciseIdx++) {
      const exercise = activity.exercises[exerciseIdx];
      const exerciseWktStepIndex = exerciseToWktStepIndex.get(exercise.exercise_title)!;

      for (let i = 0; i < exercise.sets.length; i++) {
        const set = exercise.sets[i];
        
        // Skip if no weight and no reps (empty set)
        if (set.weight_kg === null && set.reps === null) {
          continue;
        }

        // Add rest time before this set (except for the very first set)
        if (allSets.length > 0) {
          currentTimestamp += REST_TIME_MS;
        }

        // Active set timestamp
        const setTimestamp = new Date(currentTimestamp);
        const setTimestampFit = dateToFitTimestamp(setTimestamp);

        allSets.push({
          set,
          exerciseTitle: exercise.exercise_title, // Store exercise title as string
          exerciseIndex: exerciseIdx,
          setIndex: i,
          timestamp: setTimestamp,
          timestampFit: setTimestampFit,
          wktStepIndex: exerciseWktStepIndex, // Reference to workout step
        });

        // Move timestamp forward by exercise time for next set
        currentTimestamp += EXERCISE_TIME_MS;
      }
    }

    // Write sets with exercise time and rest time
    for (let i = 0; i < allSets.length; i++) {
      const setWithTs = allSets[i];
      const { set, exerciseTitle, timestampFit, wktStepIndex, timestamp } = setWithTs;

      // Determine set type: 0 = rest, 1 = active
      let setType = 0; // rest
      if (set.set_type === 'normal' || set.set_type === 'warmup') {
        setType = 1; // active
      }

      // Active sets use exerciseTimeSeconds for duration
      // Rest time is handled through timestamp gaps (elapsed time minus timer time)
      // Garmin Connect will derive rest time from the time between sets
      const durationSeconds = exerciseTimeSeconds; // Exercise time in seconds

      // Convert weight: FIT weight field has scale 16
      // According to FIT spec, we should store weight_kg * 16
      // However, Garmin Connect appears to display the raw stored value without applying scale
      // To work around this, store the actual weight value without scaling
      // This means: if weight is 25kg, store 25 (not 25*16=400)
      // Note: This is a workaround for Garmin Connect's display issue
      const weightFit = set.weight_kg ? Math.round(set.weight_kg) : 0;

      // Find matching FIT exercise using fuzzy lookup
      const exerciseMatch = await findExerciseMatch(exerciseTitle) || {
        category: 29, // totalBody (default fallback)
        categorySubtype: 0,
        confidence: 0,
      };

      // Set message (mesgNum 225) - Active set with exercise time
      encoder.writeMesg({
        mesgNum: 225, // set
        timestamp: timestampFit,
        duration: durationSeconds, // Exercise time in seconds for active sets
        repetitions: set.reps || 0,
        weight: weightFit,
        weightDisplayUnit: 1, // 1 = kilogram (fitBaseUnit.kilogram)
        setType: setType,
        startTime: timestampFit,
        wktStepName: exerciseTitle, // Exercise name as string (stored directly, not from object reference)
        wktStepIndex: wktStepIndex, // Reference to workout step message
        category: [exerciseMatch.category], // Exercise category from fuzzy match
        categorySubtype: [exerciseMatch.categorySubtype], // Exercise subtype from fuzzy match
        messageIndex: setIndex,
      });

      setIndex++;

      // Create rest event after active set (except for the last set)
      // Rest intervals use event type "rest" (value 1) with duration specified in seconds
      if (setType === 1 && i < allSets.length - 1) {
        const restStartTimestamp = timestamp.getTime() + EXERCISE_TIME_MS;
        const restStartTimestampFit = dateToFitTimestamp(new Date(restStartTimestamp));
        const restEndTimestamp = restStartTimestamp + REST_TIME_MS;
        const restEndTimestampFit = dateToFitTimestamp(new Date(restEndTimestamp));

        // Event message (mesgNum 21) - rest start
        encoder.writeMesg({
          mesgNum: 21, // event
          timestamp: restStartTimestampFit,
          event: 1, // event.rest (rest interval, value 1)
          eventType: 0, // eventType.start (start of rest)
        });

        // Event message (mesgNum 21) - rest stop
        encoder.writeMesg({
          mesgNum: 21, // event
          timestamp: restEndTimestampFit,
          event: 1, // event.rest (rest interval, value 1)
          eventType: 1, // eventType.stop (end of rest)
        });
      }
    }
  }

  return encoder.close();
}

function parseHevyTimestamp(timestampStr: string): Date {
  // Hevy format: "5 Dec 2025, 11:37"
  // Parse format: "DD MMM YYYY, HH:mm"
  const parts = timestampStr.split(',');
  if (parts.length !== 2) {
    throw new Error(`Invalid timestamp format: ${timestampStr}`);
  }

  const datePart = parts[0].trim();
  const timePart = parts[1].trim();

  const dateMatch = datePart.match(/(\d+)\s+(\w+)\s+(\d+)/);
  if (!dateMatch) {
    throw new Error(`Invalid date format: ${datePart}`);
  }

  const day = parseInt(dateMatch[1], 10);
  const monthName = dateMatch[2];
  const year = parseInt(dateMatch[3], 10);

  const monthMap: { [key: string]: number } = {
    'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
    'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11,
  };

  const month = monthMap[monthName];
  if (month === undefined) {
    throw new Error(`Invalid month: ${monthName}`);
  }

  const timeMatch = timePart.match(/(\d+):(\d+)/);
  if (!timeMatch) {
    throw new Error(`Invalid time format: ${timePart}`);
  }

  const hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);

  return new Date(year, month, day, hours, minutes);
}

