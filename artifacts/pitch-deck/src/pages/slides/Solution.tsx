export default function Solution() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg font-body">
      <div className="absolute top-[7vh] right-[6vw] text-muted text-[1.1vw] font-medium tracking-widest">
        03 / 09
      </div>

      <div className="h-full flex flex-col justify-center px-[6vw]">
        <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2vh]">
          The solution
        </p>
        <h2 className="text-text font-display font-bold text-[5.6vw] leading-[0.98] tracking-tighter max-w-[70vw]">
          From card to contact in seconds
        </h2>
        <p className="text-muted text-[1.8vw] mt-[3vh] max-w-[58vw] leading-snug text-pretty">
          Snap a card. Card Scanner Pro reads it, scores it, and files it —
          structured, deduplicated, and ready to work.
        </p>

        <div className="grid grid-cols-4 gap-[1.6vw] mt-[6vh]">
          <div className="bg-white rounded-[1vw] p-[2.2vw] border border-line">
            <span className="text-primary font-display font-bold text-[2.2vw]">Scan</span>
            <div className="w-[2.4vw] h-[0.4vh] bg-primary mt-[1.5vh] mb-[2vh]" />
            <p className="text-text text-[1.45vw] leading-snug text-pretty">
              Capture a card from web or mobile, right at the booth.
            </p>
          </div>
          <div className="bg-white rounded-[1vw] p-[2.2vw] border border-line">
            <span className="text-primary font-display font-bold text-[2.2vw]">Extract</span>
            <div className="w-[2.4vw] h-[0.4vh] bg-primary mt-[1.5vh] mb-[2vh]" />
            <p className="text-text text-[1.45vw] leading-snug text-pretty">
              AI OCR reads name, title, company and contact — bilingual.
            </p>
          </div>
          <div className="bg-white rounded-[1vw] p-[2.2vw] border border-line">
            <span className="text-primary font-display font-bold text-[2.2vw]">Score</span>
            <div className="w-[2.4vw] h-[0.4vh] bg-primary mt-[1.5vh] mb-[2vh]" />
            <p className="text-text text-[1.45vw] leading-snug text-pretty">
              Every lead gets a score, a temperature and the reasoning.
            </p>
          </div>
          <div className="bg-ink rounded-[1vw] p-[2.2vw]">
            <span className="text-primary font-display font-bold text-[2.2vw]">Sync</span>
            <div className="w-[2.4vw] h-[0.4vh] bg-primary mt-[1.5vh] mb-[2vh]" />
            <p className="text-white/85 text-[1.45vw] leading-snug text-pretty">
              Contacts land in a shared, deduplicated workspace.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
