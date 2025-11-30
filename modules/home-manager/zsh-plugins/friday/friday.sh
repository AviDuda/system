#!/bin/zsh

# %w     day of week (0..6); 0 is Sunday
if [[ $(date +%w) -eq 5 ]]; then
  echo " 🎶 🎶 🎶";
  echo "  It's Friday, Friday";
  echo "  Gotta get down on Friday";
  echo "  Everybody's lookin' forward to the weekend, weekend";
  echo "  Friday, Friday";
  echo "  Gettin' down on Friday";
  echo "  Everybody's lookin' forward to the weekend";
  echo " 🎶 🎶 🎶";
fi
