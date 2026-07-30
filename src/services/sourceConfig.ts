export const SOURCE_MAP: Record<string, string[]> = {
  "Global:All": ["TechCrunch", "Reuters Tech", "Bloomberg Technology", "The Verge", "Wired"],
  "Global:Tech": ["TechCrunch", "The Verge", "Wired", "Ars Technica", "Engadget", "Gizmodo"],
  "Global:Jobs": ["LinkedIn News", "Indeed Blog", "Glassdoor", "Forbes Careers", "Fast Company"],
  "Global:Hiring": ["LinkedIn Talent", "Recruiter.com", "SHRM", "Workable Blog"],
  "Global:Remote Work": ["Remote.com", "We Work Remotely", "FlexJobs", "Buffer Blog"],
  
  "USA:All": ["TechCrunch", "The Verge", "Wired", "CNET", "ZDNet", "Wall Street Journal"],
  "USA:Tech": ["TechCrunch", "Wired", "Ars Technica", "The Verge", "CNET"],
  "USA:Jobs": ["LinkedIn USA", "Indeed USA", "Monster.com", "CareerBuilder", "ZipRecruiter"],
  "USA:Hiring": ["LinkedIn Talent USA", "Recruiter.com", "Glassdoor for Employers"],
  
  "Europe:All": ["Tech.eu", "Sifted", "The Next Web", "EU-Startups", "BBC Tech"],
  "Europe:Tech": ["Tech.eu", "Sifted", "The Next Web", "Heise Online"],
  "Europe:Jobs": ["Eurojobs", "EURES", "Reed.co.uk", "StepStone", "Totaljobs"],
  
  "Asia:All": ["Tech in Asia", "e27", "KrASIA", "Nikkei Asia", "South China Morning Post"],
  "Asia:Tech": ["Tech in Asia", "e27", "KrASIA", "Nikkei Tech"],
  "Asia:Jobs": ["JobStreet", "JobsDB", "Wantedly", "Glints", "Hiredly"],
  
  "Africa:All": ["TechCabal", "Techpoint Africa", "Disrupt Africa", "Ventureburn", "African Business"],
  "Africa:Tech": ["TechCabal", "Techpoint Africa", "Disrupt Africa", "IT News Africa"],
  "Africa:Jobs": ["Jobberman", "BrighterMonday", "Careers24", "Jobestina"],
  
  "Nigeria:All": ["TechCabal", "Techpoint Africa", "Benjamin Dada", "TechNext", "Nairametrics"],
  "Nigeria:Tech": ["TechCabal", "Techpoint Africa", "TechNext", "Benjamin Dada"],
  "Nigeria:Jobs": ["Jobberman Nigeria", "MyJobMag", "HotNigerianJobs", "Joblist Nigeria"],
  
  "LatAm:All": ["Contxto", "Labs News", "PulsoSocial", "LatamList", "Startupi"],
  "LatAm:Tech": ["Contxto", "Labs News", "PulsoSocial"],
  "LatAm:Jobs": ["Bumeran", "Computrabajo", "LinkedIn LatAm"]
};

export function getSourcesForSelection(region: string, category: string): string[] {
  const key = `${region}:${category}`;
  const defaultKey = `${region}:All`;
  const globalKey = `Global:${category}`;
  const absoluteDefault = `Global:All`;
  
  return SOURCE_MAP[key] || SOURCE_MAP[defaultKey] || SOURCE_MAP[globalKey] || SOURCE_MAP[absoluteDefault];
}
