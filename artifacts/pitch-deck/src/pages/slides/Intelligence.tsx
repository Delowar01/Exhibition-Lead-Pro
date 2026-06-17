export default function Intelligence() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-ink font-body">
      <div className="absolute top-[7vh] right-[6vw] text-white/40 text-[1.1vw] font-medium tracking-widest">
        04 / 09
      </div>
      <div className="absolute top-0 left-0 w-[3vw] h-full bg-primary" />

      <div className="h-full flex flex-col justify-center pl-[10vw] pr-[6vw]">
        <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2vh]">
          AI engine
        </p>
        <h2 className="text-white font-display font-bold text-[5.6vw] leading-[0.98] tracking-tighter">
          The intelligence layer
        </h2>
        <p className="text-white/60 text-[1.8vw] mt-[3vh] max-w-[56vw] leading-snug text-pretty">
          Every scan runs through an AI pipeline — so the data is clean, scored
          and enriched before a rep does anything.
        </p>

        <div className="grid grid-cols-2 gap-x-[3vw] gap-y-[4vh] mt-[6vh] max-w-[72vw]">
          <div>
            <h3 className="text-white font-display font-medium text-[2.3vw] mb-[1.2vh]">
              AI OCR
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              Reads cards in English and Arabic, extracting every field.
            </p>
          </div>
          <div>
            <h3 className="text-white font-display font-medium text-[2.3vw] mb-[1.2vh]">
              Lead scoring
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              A score, a temperature, and the reasoning behind each lead.
            </p>
          </div>
          <div>
            <h3 className="text-white font-display font-medium text-[2.3vw] mb-[1.2vh]">
              Contact enrichment
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              Industry, seniority, a summary, and ready-made talking points.
            </p>
          </div>
          <div>
            <h3 className="text-white font-display font-medium text-[2.3vw] mb-[1.2vh]">
              Duplicate detection
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              Finds and merges duplicate contacts in a single pass.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
