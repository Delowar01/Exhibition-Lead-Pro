export default function MultiTenant() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg font-body">
      <div className="absolute top-[7vh] right-[6vw] text-muted text-[1.1vw] font-medium tracking-widest">
        05 / 09
      </div>

      <div className="h-full flex flex-col justify-center px-[6vw]">
        <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2vh]">
          Architecture
        </p>
        <h2 className="text-text font-display font-bold text-[5.6vw] leading-[0.98] tracking-tighter">
          Multi-tenant by design
        </h2>
        <p className="text-muted text-[1.8vw] mt-[3vh] max-w-[58vw] leading-snug text-pretty">
          Two portals, one platform. Every company is isolated by default —
          cross-tenant access is blocked, not just hidden.
        </p>

        <div className="grid grid-cols-2 gap-[2.5vw] mt-[6vh]">
          <div className="bg-ink rounded-[1.2vw] p-[3vw]">
            <span className="text-primary text-[1.1vw] font-semibold tracking-[0.25em] uppercase">
              Platform portal
            </span>
            <h3 className="text-white font-display font-medium text-[2.6vw] mt-[1.5vh] mb-[2.5vh]">
              Run every tenant
            </h3>
            <p className="text-white/70 text-[1.55vw] leading-snug text-pretty">
              Manage all tenant companies, subscriptions and platform-wide
              analytics from a single owner console.
            </p>
          </div>
          <div className="bg-white rounded-[1.2vw] p-[3vw] border border-line">
            <span className="text-primary text-[1.1vw] font-semibold tracking-[0.25em] uppercase">
              Admin portal
            </span>
            <h3 className="text-text font-display font-medium text-[2.6vw] mt-[1.5vh] mb-[2.5vh]">
              Run your company
            </h3>
            <p className="text-muted text-[1.55vw] leading-snug text-pretty">
              Contacts, a Kanban lead pipeline, events, team management and
              reports — all scoped to your own data.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-[2vw] mt-[5vh]">
          <span className="text-text text-[1.4vw] font-medium">Four roles</span>
          <div className="w-[0.5vw] h-[0.5vw] rounded-full bg-primary" />
          <span className="text-text text-[1.4vw] font-medium">Permission matrix on every write</span>
          <div className="w-[0.5vw] h-[0.5vw] rounded-full bg-primary" />
          <span className="text-text text-[1.4vw] font-medium">Strict tenant isolation</span>
        </div>
      </div>
    </div>
  );
}
