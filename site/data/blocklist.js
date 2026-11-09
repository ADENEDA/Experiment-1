// Words that must never appear by accident in a word-search grid (crude, offensive, sexual, slurs).
// The word-search engine scans every row, column and diagonal in both directions and re-fills
// filler cells until none of these remain. A hit that lies entirely inside a single placed word
// (e.g. "ASS" inside GRASS) is fine: that word was chosen on purpose.
// Uppercase A-Z only, 3+ letters. Longer forms are listed even when a shorter one covers them,
// because a short hit inside a placed word is allowed while the longer form spilling into
// filler cells is not.
export const BLOCKLIST = [
  'ANAL', 'ANUS', 'ARSE', 'ARSEHOLE', 'ASS', 'ASSES', 'ASSHOLE', 'BASTARD', 'BITCH', 'BITCHES',
  'BLOWJOB', 'BOLLOCKS', 'BONER', 'BOOB', 'BOOBS', 'BOOBIES', 'BUGGER', 'BULLSHIT', 'BUM',
  'BUTTHOLE', 'CHINK', 'CLIT', 'COCK', 'COCKS', 'COON', 'CRAP', 'CUM', 'CUNT', 'DAMN', 'DICK',
  'DILDO', 'DOUCHE', 'DYKE', 'FAG', 'FAGGOT', 'FAGS', 'FART', 'FECK', 'FUCK', 'FUCKER', 'FUCKING',
  'FUK', 'GOOK', 'HANDJOB', 'HELL', 'HOMO', 'HONKY', 'HOOKER', 'HORNY', 'JAP', 'JERKOFF', 'JIZZ',
  'KIKE', 'KKK', 'KYKE', 'MILF', 'MOFO', 'NAZI', 'NIGGA', 'NIGGER', 'NUDE', 'NUTSACK', 'ORGASM',
  'ORGY', 'PAKI', 'PECKER', 'PEE', 'PENIS', 'PISS', 'POO', 'POOP', 'PORN', 'PORNO', 'PRICK',
  'PUBE', 'PUBES', 'PUSSY', 'QUEEF', 'RAPE', 'RAPIST', 'RECTUM', 'RETARD', 'RIMJOB', 'SCROTUM',
  'SEMEN', 'SEX', 'SEXY', 'SHAG', 'SHIT', 'SHITTY', 'SKANK', 'SLUT', 'SMEGMA', 'SODOMY', 'SPERM',
  'SPIC', 'SPIK', 'SPUNK', 'SUCK', 'SUCKS', 'TESTES', 'TIT', 'TITS', 'TITTY', 'TOSSER', 'TRANNY',
  'TURD', 'TWAT', 'VAGINA', 'VULVA', 'WANK', 'WANKER', 'WETBACK', 'WHORE', 'WTF', 'XXX',
  // More slurs and crude words.
  'BELLEND', 'DAGO', 'GYP', 'MINGE', 'NEGRO', 'SPAZ', 'TARD', 'WOP',
  // Longer forms of words that end a theme word (GRAPE, RACCOON, GRASS...), so a filler letter after
  // the theme word cannot turn it into one of these.
  'ASSHAT', 'ASSWIPE', 'COONS', 'RAPED', 'RAPES', 'RAPING',
];
