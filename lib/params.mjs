// Tunable constants of the physics. Changing any value defines a new physics version.
export const P = {
  SPECIES_THRESHOLD: .28, NUTRIENT: .8,                  // initial dissolved nutrient per cell: sets the world's total matter
  PMAX: .25, KN: .15, LIGHT_SHARE: .35,                // photosynthesis of individual plants
  ALGAE_R: .04, ALGAE_MAX: 1, ALGAE_SEED: .02, ALGAE_DEATH: .0005, ALGAE_RATE: .5, // algal carpet on the field grid
  BITE_RATE: .35, ATTACK_RATE: 1.2, DETRITUS_RATE: .15, CROP_FLOOR: .3, ROOT_SCALE: .3,   // feeding
  PLANT_EFF: .4, MEAT_EFF: .6, BASE_EFF: .1, MEAT_BASE: .3, MOTILE_LIGHT_MASS: 1, // assimilation: base + specialisation × diet; meat is easier to digest than plants
  BASE_UPKEEP: .0022, EYE_UPKEEP: .003, MOUTH_UPKEEP: .003, MUSCLE_UPKEEP: .003, GLOW_UPKEEP: .001, FAT_UPKEEP: .0006,
  MOTION_COST: .005, GLOW_COST: .01, FLASH_ESCAPE: .8, FLASH_ESCAPE_MAX: .5, FLASH_COST: .02, // a bitten animal with light organs flashes; the startled attacker may let go
  TENTACLE_UPKEEP: .002, SPINE_UPKEEP: .0008, TENTACLE_REACH: 2.2, SPINE_HARM: .6,   // body plan: tentacles reach and hold, spines sting the biter
  PLAN_RATE: .01, RADIAL_ECONOMY: .7,
  SEGMENT_ECONOMY: .07, SEGMENT_RATE: .008, FORM_RATE: .006, STEM_MASS: .4,       // segments save upkeep; a bush puts .4 of its chloroplast into a stem                                                               // symmetry changes in 1% of births; a radial (gelatinous) body costs .7 to keep and to move
  MATURITY_BASE: 60, MATURITY_MASS: 300, RESERVE: .35, GROW_RESERVE: .5,  // reproduction and growth keep a night's reserve
  KELP_MASS: .35, KELP_DEPTH: .65, RUNNER_MASS: .1, RUNNER_CLONE: .5, RUNNER_GRAZE: .8, SHELL_MASS: .45, SHELL_DEFENSE: .35, SHELL_GRAZE: .75, FLOAT_UPKEEP: .0035, FLOAT_DEPTH: .6, // more growth forms
  PIGMENT_GAIN: .5, PIGMENT_COST: .35, LEAF_LIGHT: .3, LEAF_GRAZE: .6,     // pigments suit a depth; broad leaves catch light and are eaten more
  UPWELL_SEDIMENT: 86400, UPWELL_WATER: 2 * 86400,       // upwelling along the slopes: the sediment returns in a day, deep water rises in two
  STORM_MEAN: 3 * 86400, RED_TIDE_MEAN: 4 * 86400, CURRENT_MEAN: 4 * 86400, BLOOM_MEAN: 4 * 86400, // weather: about one event a day, one at a time
  METEOR_MEAN: 60 * 86400, VOLCANO_MEAN: 15 * 86400, STRAIN_MEAN: 8 * 3600
};
