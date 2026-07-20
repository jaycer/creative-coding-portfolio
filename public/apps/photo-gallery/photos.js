// The shoot list, in the order it reads on the page. A group is whatever reads
// as one body of work — a property, a trip, a shoot — so adding a new kind of
// photography later just means appending another group here; nothing in the
// grid or the viewer assumes these are real estate. `caption` is what shows
// under the photo in the modal, defaulting to the group title when a group's
// photos don't need individual captions.
//
// The property groups are a curated best-of per listing (not the full delivered
// set) — files are named <property>-NN in reading order. India and Scare BNB
// keep their weebee names (REN). Full-resolution sources live outside this repo
// under ~/RE Photos and ~/Code/weebee, so any of these can be re-exported.
//
// Photos ship as AVIF — roughly a quarter the bytes of the source JPEGs at the
// same apparent quality, which is what makes it reasonable to keep them in the
// repo at all. Deliberately no JPEG fallback: AVIF is ~94% globally (everything
// since Edge 121, Jan 2024), and carrying a second copy of every photo would
// undo the savings. See [[avif-photo-conversion-recipe]] in memory.
export const groups = [
  {
    title: '373 Erie Rd, Vermilion',
    files: ['erie-01', 'erie-02', 'erie-03', 'erie-04', 'erie-05', 'erie-06', 'erie-07', 'erie-08'],
  },
  {
    title: '7244 Ridge Rd, Parma',
    files: ['ridge-01', 'ridge-02', 'ridge-03', 'ridge-04', 'ridge-05', 'ridge-06'],
  },
  {
    title: '33874 Mapleridge Blvd, Avon',
    files: ['mapleridge-01', 'mapleridge-02', 'mapleridge-03', 'mapleridge-04', 'mapleridge-05', 'mapleridge-06', 'mapleridge-07'],
  },
  {
    title: '17705 Lakeshore Blvd, Cleveland',
    files: ['lakeshore-01', 'lakeshore-02', 'lakeshore-03', 'lakeshore-04', 'lakeshore-05'],
  },
  {
    title: 'Scare BNB',
    note: 'July 2024',
    files: ['RE7', 'RE8', 'RE9', 'RE11', 'RE12'],
  },
  {
    title: 'India',
    note: 'December 2017',
    files: [
      { file: 'RE4', caption: 'Taj Mahal, India' },
      { file: 'RE6', caption: 'Fatehpur Sikri, India' },
      { file: 'RE5', caption: 'Step Well, India' },
    ],
  },
];

// Flatten to the single list the modal steps through with the arrow keys, so
// left/right walks the whole portfolio rather than stopping at a group edge.
export const photos = groups.flatMap((group, groupIndex) =>
  group.files.map((entry) => {
    const item = typeof entry === 'string' ? { file: entry } : entry;
    return {
      groupIndex,
      group: group.title,
      file: item.file,
      caption: item.caption || group.title,
      note: item.note || group.note || '',
      full: `./photos/${item.file}.avif`,
      thumb: `./photos/thumbs/${item.file}.avif`,
    };
  })
);
