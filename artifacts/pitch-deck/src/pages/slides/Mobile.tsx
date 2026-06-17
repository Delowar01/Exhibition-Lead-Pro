export default function Mobile() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg font-body">
      <div className="absolute top-[7vh] right-[6vw] text-muted text-[1.1vw] font-medium tracking-widest">
        06 / 09
      </div>
      <div className="absolute top-0 right-0 w-[42vw] h-full bg-[#f2ece2]" />

      <div className="relative h-full grid grid-cols-[1fr_0.8fr] items-center">
        <div className="flex flex-col justify-center pl-[6vw] pr-[4vw]">
          <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2vh]">
            Mobile
          </p>
          <h2 className="text-text font-display font-bold text-[5.4vw] leading-[0.98] tracking-tighter">
            The field-sales app
          </h2>
          <p className="text-muted text-[1.8vw] mt-[3vh] max-w-[40vw] leading-snug text-pretty">
            The whole platform in a rep's pocket — built for the floor, not the
            desk.
          </p>

          <div className="flex flex-col gap-[2.8vh] mt-[5vh] max-w-[40vw]">
            <div className="flex items-start gap-[1.3vw]">
              <span className="text-primary font-display font-bold text-[1.8vw] leading-none mt-[0.3vh]">—</span>
              <p className="text-text text-[1.6vw] font-medium leading-snug text-pretty">
                Scan and qualify cards on the spot, between conversations.
              </p>
            </div>
            <div className="flex items-start gap-[1.3vw]">
              <span className="text-primary font-display font-bold text-[1.8vw] leading-none mt-[0.3vh]">—</span>
              <p className="text-text text-[1.6vw] font-medium leading-snug text-pretty">
                Browse contacts, leads and events from one home screen.
              </p>
            </div>
            <div className="flex items-start gap-[1.3vw]">
              <span className="text-primary font-display font-bold text-[1.8vw] leading-none mt-[0.3vh]">—</span>
              <p className="text-text text-[1.6vw] font-medium leading-snug text-pretty">
                Email a contact straight from the card, using any mail app.
              </p>
            </div>
          </div>
        </div>

        <div className="relative flex items-center justify-center">
          <div className="relative w-[20vw] h-[42vw] rounded-[3vw] bg-ink p-[0.8vw] shadow-2xl">
            <div className="w-full h-full rounded-[2.3vw] bg-bg overflow-hidden flex flex-col">
              <div className="bg-primary px-[1.6vw] pt-[3.2vh] pb-[2vh]">
                <p className="text-white/80 text-[1vw] font-medium">Good morning</p>
                <p className="text-white font-display font-bold text-[1.9vw] leading-tight">My Pipeline</p>
              </div>
              <div className="flex-1 p-[1.4vw] flex flex-col gap-[1.2vh]">
                <div className="bg-white rounded-[1vw] p-[1.3vw] border border-line">
                  <div className="flex items-center justify-between mb-[0.6vh]">
                    <span className="text-text font-display font-medium text-[1.25vw]">A. Rahman</span>
                    <span className="text-primary font-display font-bold text-[1.25vw]">92</span>
                  </div>
                  <p className="text-muted text-[1vw]">VP Sales · Hot</p>
                </div>
                <div className="bg-white rounded-[1vw] p-[1.3vw] border border-line">
                  <div className="flex items-center justify-between mb-[0.6vh]">
                    <span className="text-text font-display font-medium text-[1.25vw]">L. Haddad</span>
                    <span className="text-primary font-display font-bold text-[1.25vw]">74</span>
                  </div>
                  <p className="text-muted text-[1vw]">Director · Warm</p>
                </div>
                <div className="bg-white rounded-[1vw] p-[1.3vw] border border-line">
                  <div className="flex items-center justify-between mb-[0.6vh]">
                    <span className="text-text font-display font-medium text-[1.25vw]">S. Mensah</span>
                    <span className="text-primary font-display font-bold text-[1.25vw]">61</span>
                  </div>
                  <p className="text-muted text-[1vw]">Buyer · Warm</p>
                </div>
                <div className="mt-auto bg-ink rounded-[1vw] py-[1.4vh] flex items-center justify-center">
                  <span className="text-white font-display font-medium text-[1.2vw]">Scan a card</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
