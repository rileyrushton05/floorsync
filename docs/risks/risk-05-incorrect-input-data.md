# Risk: Incorrect Input Data

## Description

Machine capability data (e.g., processing times, setup times, machine availability) is entered incorrectly. This will lead to invalid schedules and inaccurate simulations.

## Likelihood

Medium

## Impact

High

## Mitigation Plan

- Design the input interface with data validation (e.g., no negative processing times, correct format)
- Implement clear input forms with tooltips and descriptions for each field
- Create a "data import" feature from a standard format (e.g., CSV) to allow for bulk uploads and reduce manual entry errors
- Add data preview before final submission

## Contingency Plan

- Allow users to easily edit and correct the input data after it's been entered
- Provide a "data validation" tool that highlights potentially erroneous data points to the user before generating a schedule
- Implement a rollback feature to revert to a previous valid dataset
- Display warnings for suspicious data values

## Status

Open