// A paid start and a read-only lookup are separate actions. Keep the receipt tied
// to its region until the server confirms the previous run has settled.
function regionCollection(request, refresh, expireSession) {
  const panel = document.getElementById('collectionPanel');
  const start = document.getElementById('collectRegion');
  const recover = document.getElementById('recoverCollection');
  const stop = document.getElementById('stopCollection');
  const feedback = document.getElementById('collectionFeedback');
  const outcomes = {SUCCEEDED:'수집 완료', FAILED:'수집 실패', ABORTED:'수집 중단', 'TIMED-OUT':'실행 시간 초과'};
  let context = null;
  let controller = null;
  let previous = null;
  let sendingStart = false;
  let stopAfterReceipt = false;

  function draw() {
    const location = context?.conditions?.location;
    const resume = previous?.id && previous.location === location;
    panel.hidden = !context?.signedIn;
    recover.disabled = !context?.signedIn || Boolean(controller);
    start.hidden = !location;
    start.disabled = !context?.signedIn || !location || context.busy || Boolean(controller) ||
      (!resume && (!context.enabled || Boolean(previous)));
    start.textContent = resume ? '이 지역 수집 상태 다시 확인' : (location || '선택 지역') + ' 매물 수집';
    stop.hidden = !controller;
    stop.disabled = stopAfterReceipt;
  }

  function update(next) {
    if (!next.signedIn || context?.conditions?.location !== next.conditions?.location) {
      controller?.abort();
      controller = null;
      sendingStart = false;
      stopAfterReceipt = false;
    }
    if (!next.signedIn) { previous = null; feedback.textContent = ''; }
    context = next;
    draw();
  }

  function pause(signal) {
    return new Promise((resolve, reject) => {
      function abort() {
        clearTimeout(timer);
        reject(new DOMException('조회 중단', 'AbortError'));
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 3000);
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    });
  }

  // An active lookup may find a job for a different region, or an older lock
  // without a recoverable receipt. Never infer its region from the search box.
  async function showJob(job, known) {
    if (job.state === 'IDLE') {
      previous = null;
      feedback.textContent = '진행 중이거나 정산을 기다리는 수집이 없어요.';
      return true;
    }
    const location = job.conditions?.location || known?.location || null;
    previous = {id:job.jobId || known?.id || null, location};
    const prefix = location ? location + ' · ' : '';
    if (job.state === 'UNIDENTIFIED' || job.state === 'START_UNCONFIRMED') {
      feedback.textContent = prefix + (job.state === 'UNIDENTIFIED' ? '이전 수집 실행을 식별할 수 없어요.' : '수집 시작 여부를 확인할 수 없어요.') + ' 운영 콘솔에서 실행 기록을 확인해 주세요.';
      return true;
    }
    if (Object.hasOwn(outcomes, job.state)) {
      const count = Number.isInteger(job.persistedCount) ? ' · 저장한 매물 ' + job.persistedCount + '건' : '';
      const outcome = outcomes[job.state] + (job.state === 'SUCCEEDED' ? count : '');
      if (job.settlementIssue === 'COST_EXCEEDS_RESERVATION') {
        feedback.textContent = prefix + outcome + ' · 실행 비용이 예약액을 초과했어요. 매물 운영 화면에서 Apify 실행 이력을 확인해 주세요.';
      } else if (job.settlementIssue === 'INVALID_LEDGER') {
        feedback.textContent = prefix + outcome + ' · 월 예산 기록과 예약액이 일치하지 않아 다음 수집을 보류했어요.';
      } else if (job.costSettled !== true) {
        feedback.textContent = prefix + outcome + ' · 비용 정산 확인 중이에요. 이전 수집 상태를 다시 확인해 주세요.';
      } else {
        previous = null;
        feedback.textContent = prefix + outcome + ' · 비용 정산이 끝났어요.';
        if (known && job.state === 'SUCCEEDED' && location && location === context.conditions?.location) await refresh(location);
      }
      return true;
    }
    const limit = Number.isInteger(job.maxResults) ? '최대 ' + job.maxResults + '건 · ' : '';
    feedback.textContent = prefix + limit + (job.state === 'RESERVED' ? '시작을 기다리는 수집이 있어요.' : '이전 수집이 진행 중이에요.');
    return false;
  }

  stop.addEventListener('click', () => {
    if (sendingStart) {
      // Receive the ID from the already submitted POST; resuming needs only GET.
      stopAfterReceipt = true;
      stop.disabled = true;
    } else controller?.abort();
    feedback.textContent = '상태 조회를 중단했어요. 이미 시작한 수집은 계속될 수 있어요.';
  });

  async function check(activeLookup) {
    if (!context?.signedIn || controller) return;
    const {query,conditions} = context;
    const resume = previous?.id && previous.location === conditions?.location;
    if (!activeLookup) {
      if (start.disabled || !conditions?.location) return;
      if (!resume && !window.confirm(conditions.location + ' 매물을 최대 20건 수집할까요? 이번 실행 비용 상한은 $0.51이며, 조회를 중단해도 실행 비용이 발생할 수 있어요.')) return;
    }
    const operation = new AbortController();
    controller = operation;
    stopAfterReceipt = false;
    draw();
    try {
      if (activeLookup) {
        feedback.textContent = '이전 수집 상태를 확인하고 있어요.';
        const job = await request('/api/collect-status?active=1', undefined, operation.signal);
        if (!operation.signal.aborted) await showJob(job, null);
        return;
      }
      if (!resume) {
        sendingStart = true;
        previous = {id:null, location:conditions.location};
        feedback.textContent = '수집 요청을 보내고 있어요.';
        const job = await request('/api/collect', {query, confirmedConditions:conditions}, operation.signal);
        if (operation.signal.aborted) return;
        if (!job.jobId) throw Error('수집 접수 여부를 확인할 수 없어요. 이전 수집 상태를 확인해 주세요.');
        sendingStart = false;
        previous.id = job.jobId;
        if (stopAfterReceipt) return;
      }
      feedback.textContent = '수집 상태를 확인하고 있어요.';
      for (let attempt = 0; attempt < 90; attempt++) {
        const job = await request('/api/collect-status?jobId=' + encodeURIComponent(previous.id), undefined, operation.signal);
        if (operation.signal.aborted || await showJob(job, previous)) return;
        await pause(operation.signal);
      }
      feedback.textContent = '아직 수집이 끝나지 않았어요. 이전 수집 상태를 다시 확인해 주세요.';
    } catch (error) {
      if (operation.signal.aborted) return;
      if (error.status === 401) { expireSession(); return; }
      if (activeLookup && !previous) previous = {id:null, location:null};
      if (sendingStart && [400,402,403,422,429].includes(error.status)) previous = null;
      feedback.textContent = sendingStart && !error.status
        ? '접수 여부를 확인할 수 없어요. 이전 수집 상태를 확인해 주세요.'
        : error.message || '이전 수집 상태를 확인할 수 없어요.';
    } finally {
      if (controller === operation) {
        controller = null;
        sendingStart = false;
        stopAfterReceipt = false;
        draw();
      }
    }
  }
  start.addEventListener('click', () => check(false));
  recover.addEventListener('click', () => check(true));
  return {update};
}
