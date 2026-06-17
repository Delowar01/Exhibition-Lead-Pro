export default function Problem() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg font-body">
      <div className="absolute top-0 right-0 w-[40vw] h-full bg-[#f2ece2]" />
      <div className="absolute top-[7vh] right-[6vw] text-muted text-[1.1vw] font-medium tracking-widest">
        02 / 09
      </div>

      <div className="relative h-full grid grid-cols-[1fr_0.85fr]">
        <div className="flex flex-col justify-center pl-[6vw] pr-[4vw]">
          <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2.5vh]">
            The problem
          </p>
          <h2 className="text-text font-display font-bold text-[6vw] leading-[0.98] tracking-tighter">
            The cost of paper
          </h2>
          <p className="text-muted text-[1.9vw] mt-[4vh] max-w-[40vw] leading-snug text-pretty">
            Field teams still run on stacks of business cards. The data sits in a
            pocket until someone finds the time to type it in.
          </p>
        </div>

        <div className="relative flex flex-col justify-center pr-[6vw] pl-[3vw] gap-[3.5vh]">
          <div className="flex items-start gap-[1.5vw]">
            <span className="text-primary font-display font-bold text-[2.6vw] leading-none">01</span>
            <p className="text-text text-[1.7vw] font-medium leading-snug text-pretty">
              Hundreds of cards collected per event — most never reach the CRM.
            </p>
          </div>
          <div className="w-full h-[1px] bg-line" />
          <div className="flex items-start gap-[1.5vw]">
            <span className="text-primary font-display font-bold text-[2.6vw] leading-none">02</span>
            <p className="text-text text-[1.7vw] font-medium leading-snug text-pretty">
              Manual entry is slow, error-prone, and happens days later.
            </p>
          </div>
          <div className="w-full h-[1px] bg-line" />
          <div className="flex items-start gap-[1.5vw]">
            <span className="text-primary font-display font-bold text-[2.6vw] leading-none">03</span>
            <p className="text-text text-[1.7vw] font-medium leading-snug text-pretty">
              By the time a lead is typed up, the conversation has gone cold.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
