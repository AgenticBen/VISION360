# Geography definition — PROVISIONAL

**Status: drafted by us, not supplied by the project lead. Needs her sign-off.**

This file is the single source of truth for geography. Do not hardcode counties anywhere
else in the codebase.

## What was actually said

The scope is "the greater Charlotte area," deliberately not limited to Charlotte city or
Mecklenburg County. The project lead's standing instruction is that we do not say no to
anyone until we have to, and to stay open to the largest degree possible. She has already
taken and kept a referral from Raleigh.

The county list below is our working interpretation of "greater Charlotte." She never
named counties. Confirm before treating it as settled.

## Working county list

North Carolina: Mecklenburg, Union, Cabarrus, Gaston, Iredell, Lincoln, Rowan, Cleveland,
Stanly, Catawba.

South Carolina: York, Lancaster.

Statewide North Carolina bodies count as `in_area` when a Charlotte-area resident can
actually use them.

## Verdicts

- `in_area` — serves one or more counties above, or is statewide and usable from Charlotte
- `partial` — serves part of the region, or serves it only under certain conditions
- `statewide_travel_required` — usable but requires significant travel (Duke Eye Center in
  Durham, Governor Morehead School in Raleigh)
- `out_of_area` — outside the region, but retained because they may still accept a
  referral from here

## The rule that matters

Geography sorts. It never excludes. Nothing is deleted from the dataset for being far
away. Tag it and let the site filter it, so nobody is silently dropped and nobody is sent
on a three-hour drive without being told.
