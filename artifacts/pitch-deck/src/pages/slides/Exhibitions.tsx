export default function Exhibitions() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-ink font-body">
      <div className="absolute top-[7vh] right-[6vw] text-white/40 text-[1.1vw] font-medium tracking-widest">
        07 / 09
      </div>

      <div className="h-full flex flex-col justify-center px-[6vw]">
        <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2vh]">
          Use case
        </p>
        <h2 className="text-white font-display font-bold text-[5.6vw] leading-[0.98] tracking-tighter max-w-[64vw]">
          Built for GCC exhibitions
        </h2>
        <p className="text-white/60 text-[1.8vw] mt-[3vh] max-w-[58vw] leading-snug text-pretty">
          GITEX, Arab Health, ATM — thousands of cards across days, in two
          languages, collected by a team that needs one shared view.
        </p>

        <div className="grid grid-cols-3 gap-[2.5vw] mt-[7vh]">
          <div className="border-t-2 border-primary pt-[2.5vh]">
            <h3 className="text-white font-display font-medium text-[2.1vw] mb-[1.5vh]">
              Bilingual capture
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              OCR reads English and Arabic cards without a second tool.
            </p>
          </div>
          <div className="border-t-2 border-primary pt-[2.5vh]">
            <h3 className="text-white font-display font-medium text-[2.1vw] mb-[1.5vh]">
              One shared pipeline
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              The whole booth scans into one deduplicated workspace.
            </p>
          </div>
          <div className="border-t-2 border-primary pt-[2.5vh]">
            <h3 className="text-white font-display font-medium text-[2.1vw] mb-[1.5vh]">
              Scored by close
            </h3>
            <p className="text-white/65 text-[1.5vw] leading-snug text-pretty">
              Leads are scored and ready before the doors shut for the day.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
