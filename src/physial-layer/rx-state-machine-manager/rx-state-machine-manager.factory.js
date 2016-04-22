var RxStateMachineManager = (function () {
    'use strict';

    _RxStateMachineManager.$inject = [];

    _RxStateMachineManager.INITIAL_POWER_THRESHOLD = 0;     // after init we need to listen to noise so this threshold should prevent catching all possible signals
    _RxStateMachineManager.OFDM_PILOT_SIGNAL_INDEX = 0;
    _RxStateMachineManager.INITIAL_DIFFERENCE_BETWEEN_NOISE_AND_SIGNAL = 10;  // decibels above average noise level to be able to catch first even weak signal - it means that you should keep this value low
    _RxStateMachineManager.THRESHOLD_DIFFERENCE_BETWEEN_AVERAGE_SIGNAL_POWER_UNIT_FACTOR = 0.3;  // 0.0 -> closer to signal, 1.0 -> closer to noise
    _RxStateMachineManager.NO_INPUT_POWER = -99;                         // TODO, move to some common place

    function _RxStateMachineManager() {
        var RSMM;

        RSMM = function (channelIndex, audioNetworkPhysicalLayer, packetReceiveHandler) {
            this.$$channelIndex = channelIndex;
            this.$$audioNetworkPhysicalLayer = audioNetworkPhysicalLayer;
            this.$$packetReceiveHandler = packetReceiveHandler;
            this.$$stateMachine = RxStateMachineBuilder.build(
                this.$$handlerIdleInit.bind(this),
                this.$$handlerFirstSyncWait.bind(this),
                this.$$handlerSignalInit.bind(this),
                this.$$handlerFatalError.bind(this),
                this.$$handlerIdle.bind(this),
                this.$$handlerSymbol.bind(this),
                this.$$handlerSync.bind(this),
                this.$$handlerGuard.bind(this),
                this.$$handlerError.bind(this)
            );

            this.$$sampleCollectionTimeNoise = null;
            this.$$sampleCollectionTimeSignal = null;
            this.$$syncPreamble = null;
            this.$$pskSize = null;

            this.reset(true);
        };

        RSMM.prototype.reset = function (fromConstructor) {
            if (typeof fromConstructor === 'undefined') {
                fromConstructor = false;
            }

            this.$$maxSignalPower = null;
            this.$$maxSignalPowerSampleSize = null;
            this.$$minGuardPower = null;
            this.$$minGuardPowerSampleSize = null;
            this.$$averageNoisePower = null;
            this.$$averageSignalPower = null;

            this.$$powerHistoryNoise = [];
            this.$$powerHistoryGuard = [];
            this.$$powerHistorySignal = [];
            this.$$phaseHistory = [];

            this.$$powerThreshold = _RxStateMachineManager.INITIAL_POWER_THRESHOLD;

            this.$$currentData = null;
            this.$$dataPacket = [];
            this.$$dataSymbol = [];

            if (!fromConstructor) {
                this.$$stateMachine.scheduleReset();
            }
        };

        RSMM.prototype.setSymbolStateMaxDurationTime = function (value) {
            this.$$stateMachine.setSymbolStateMaxDurationTime(value);
        };

        RSMM.prototype.setGuardStateMaxDurationTime  = function (value) {
            this.$$stateMachine.setGuardStateMaxDurationTime(value);
        };

        RSMM.prototype.setSyncStateMaxDurationTime = function (value) {
            this.$$stateMachine.setSyncStateMaxDurationTime(value);
        };

        RSMM.prototype.setSampleCollectionTimeNoise = function (value) {
            this.$$sampleCollectionTimeNoise = value;
        };

        RSMM.prototype.setSampleCollectionTimeSignal = function (value) {
            this.$$sampleCollectionTimeSignal = value;
        };

        RSMM.prototype.setSyncPreamble  = function (value) {
            this.$$syncPreamble = value;
        };

        RSMM.prototype.setPskSize  = function (value) {
            this.$$pskSize = value;
        };

        RSMM.prototype.$$handlerIdleInit = function (stateDurationTime) {
            // if we have all needed information we can go to 'first sync wait' state
            if (this.$$averageNoisePower !== null) {
                return RxStateMachine.STATE.FIRST_SYNC_WAIT;
            }

            // collect desired noise power history and later compute average noise power and power threshold
            if (stateDurationTime < this.$$sampleCollectionTimeNoise) {
                this.$$powerHistoryNoise.push(this.$$currentData.pilotSignal.powerDecibel);
            } else {
                this.$$averageNoisePower = AudioUtil.computeAverage(this.$$powerHistoryNoise);
                this.$$powerHistoryNoise.length = 0;

                // put first power threshold slightly above average noise power to detect even weak signals
                this.$$powerThreshold = this.$$averageNoisePower + _RxStateMachineManager.INITIAL_DIFFERENCE_BETWEEN_NOISE_AND_SIGNAL;
            }
        };

        RSMM.prototype.$$handlerFirstSyncWait = function (stateDurationTime) {
            // nothing much here
        };

        RSMM.prototype.$$handlerSignalInit = function (stateDurationTime) {
            var 
                powerDecibel = this.$$currentData.pilotSignal.powerDecibel,
                thresholdDifferenceBetweenAverageSignalPower
            ;

            // if we have all needed information and pilot signal is gone we can go to idle state
            if (this.$$averageSignalPower !== null && !this.$$isPilotSignalPresent()) {
                return RxStateMachine.STATE.IDLE;
            }

            // signal cannot be weaker that noise... :)
            if (powerDecibel <= this.$$averageNoisePower) {
                return RxStateMachine.STATE.FATAL_ERROR;
            }

            // collect desired signal power history and later compute average signal power and power threshold
            if (stateDurationTime < this.$$sampleCollectionTimeSignal) {
                this.$$powerHistorySignal.push(powerDecibel);
            } else {
                if (this.$$averageSignalPower === null) {
                    this.$$averageSignalPower = AudioUtil.computeAverage(this.$$powerHistorySignal);
                    this.$$powerHistorySignal.length = 0;
                    thresholdDifferenceBetweenAverageSignalPower = (
                        _RxStateMachineManager.THRESHOLD_DIFFERENCE_BETWEEN_AVERAGE_SIGNAL_POWER_UNIT_FACTOR *
                        (this.$$averageSignalPower - this.$$averageNoisePower)
                    );

                    // put threshold somewhere (depending on unit factor) between average signal and average noise level
                    this.$$powerThreshold = this.$$averageSignalPower - thresholdDifferenceBetweenAverageSignalPower;
                }
            }

            // collect phase history for all ofdm subcarriers - it will be later used for fine-tune frequency offets
            this.$$collectPhaseHistory(stateDurationTime, this.$$currentData.carrierDetail);
        };

        RSMM.prototype.$$handlerFatalError = function (stateDurationTime) {
            // nothing much here - manual state machine reset is a way to get out if this state
        };
        
        RSMM.prototype.$$handlerIdle = function (stateDurationTime) {
            var packetDataFinal;

            // share collected packet with rest of the world
            if (this.$$dataPacket.length > 0) {
                if (this.$$packetReceiveHandler) {
                    packetDataFinal = this.$$preparePacket(this.$$dataPacket);
                    this.$$packetReceiveHandler(this.$$channelIndex, packetDataFinal);
                }

                this.$$dataPacket.length = 0;
            }

            // try to fine-tune frequency offsets basing on phase history
            if (this.$$phaseHistory.length > 0) {
                this.$$handlePhaseHistory(this.$$phaseHistory);
                this.$$phaseHistory.length = 0;
            }

            // clear last guard history because it's followed directly by idle state
            // so technically it wasn't guard state at all
            this.$$powerHistoryGuard.length = 0;
        };

        RSMM.prototype.$$handlerSymbol = function (stateDurationTime) {
            // update current min guard power
            if (this.$$powerHistoryGuard.length > 0) {
                this.$$minGuardPower = MathUtil.minInArray(this.$$powerHistoryGuard);
                this.$$minGuardPowerSampleSize = this.$$powerHistoryGuard.length;
                this.$$powerHistoryGuard.length = 0;
            }

            // store signal power history
            this.$$powerHistorySignal.push(
                this.$$currentData.pilotSignal.powerDecibel
            );

            // add current signal sample to list
            this.$$dataSymbol.push(this.$$currentData);
        };

        RSMM.prototype.$$handlerSync = function (stateDurationTime) {
            // collect phase history for all ofdm subcarriers - it will be later used for fine-tune frequency offets
            this.$$collectPhaseHistory(stateDurationTime, this.$$currentData.carrierDetail);
        };

        RSMM.prototype.$$handlerGuard = function (stateDurationTime) {
            var bestQualityIndex;

            // update current max signal power
            if (this.$$powerHistorySignal.length > 0) {
                this.$$maxSignalPower = MathUtil.maxInArray(this.$$powerHistorySignal);
                this.$$maxSignalPowerSampleSize = this.$$powerHistorySignal.length;
                this.$$powerHistorySignal.length = 0;
            }

            // store guard power history
            this.$$powerHistoryGuard.push(
                this.$$currentData.pilotSignal.powerDecibel
            );

            // find best signal sample and add to current packet
            if (this.$$dataSymbol.length > 0) {
                bestQualityIndex = AudioUtil.findMaxValueIndex(this.$$dataSymbol, 'pilotSignal.powerDecibel');
                this.$$dataPacket.push(
                    this.$$dataSymbol[bestQualityIndex].carrierDetail
                );
                if (this.$$isPacketSyncPreamble()) {
                    this.$$handlePacketSyncPreamble(
                        this.$$dataSymbol[bestQualityIndex].carrierDetail
                    );
                }
                this.$$dataSymbol = [];
            }
        };

        RSMM.prototype.$$handlerError = function (stateDurationTime) {
            // nothing much here - this state will automatically transit to idle when pilot signal will be gone
        };

        RSMM.prototype.$$collectPhaseHistory = function (stateDurationTime, carrierDetail) {
            this.$$phaseHistory.push({
                time: stateDurationTime,
                phase: carrierDetail[0].phase      // TODO pass all ofdm phases here !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
            });                                    // TODO check also powerThreshold to avoid fine-tune on null OFDMs
        };

        RSMM.prototype.$$handlePhaseHistory = function (phaseHistory) {
            var i, str = '', indexA, indexB, drift, current;

            // TODO change that temporary code
            for (i = 0; i < phaseHistory.length; i++) {
                str += (
                  (Math.round(phaseHistory[i].time * 1000) / 1000) + ' ' +
                  (Math.round(phaseHistory[i].phase * 1000) / 1000) + ' | '
                );
            }

            indexA = Math.round(0.43 * phaseHistory.length);
            indexB = Math.round(0.57 * phaseHistory.length);

            indexB = indexB >= phaseHistory.length ? phaseHistory.length - 1 : indexB;

            // console.log('phase history: ', str);

            if (indexA !== indexB && indexA < indexB) {
                console.log('phase history indexA', phaseHistory[indexA].time, phaseHistory[indexA].phase);
                console.log('phase history indexB', phaseHistory[indexB].time, phaseHistory[indexB].phase);
                drift = -(phaseHistory[indexB].phase - phaseHistory[indexA].phase) / (phaseHistory[indexB].time - phaseHistory[indexA].time);

                console.log('phase history drift', drift);

                if (Math.abs(drift) > 0.005) {
                    current = anpl.getRxFrequency(this.$$channelIndex, 0);
                    console.log('phase history current', current);
                    anpl.setRxFrequency(this.$$channelIndex, 0, current + drift);
                    console.log('Frequency corrected for channel ' + this.$$channelIndex + ' at ofdm ' + 0 + ': ' + (current + drift));
                    uiRefresh();
                }
            }
        };

        RSMM.prototype.$$handlePacketSyncPreamble = function (carrierDetail) {
            var current, i;

            // TODO notify about phase correction
            for (i = 0; i < carrierDetail.length; i++) {
                current = anpl.getRxPhaseCorrection(this.$$channelIndex, i);
                anpl.setRxPhaseCorrection(this.$$channelIndex, i, current + carrierDetail[i].phase);
                console.log('Phase corrected for channel ' + this.$$channelIndex + ' at ofdm ' + i + ': ' + (current + carrierDetail[i].phase));
                uiRefresh();
            }
        };

        RSMM.prototype.$$preparePacket = function (dataPacket) {
            var i, j, result, ofdmList, carrierDetail;

            result = [];
            for (i = 0; i < dataPacket.length; i++) {
                if (i === 0 && this.$$syncPreamble) {
                    // when syncPreamble is true then first burst is used only for phase
                    // alignment - we can simply ommit it in the final packet
                    continue;
                }
                carrierDetail = dataPacket[i];
                ofdmList = [];
                for (j = 0; j < carrierDetail.length; j++) {
                    ofdmList.push(
                        Math.round(carrierDetail[j].phase * this.$$pskSize) % this.$$pskSize
                    );
                }
                result.push(ofdmList);
            }

            return result;
        };

        RSMM.prototype.$$isPacketSyncPreamble = function () {
            return this.$$syncPreamble && this.$$dataPacket.length === 1;
        };

        RSMM.prototype.$$isInputReallyConnected = function (powerDecibel) {
            return (
                (this.$$averageNoisePower !== null && this.$$averageSignalPower !== null) ||
                powerDecibel !== _RxStateMachineManager.NO_INPUT_POWER
            );
        };

        RSMM.prototype.$$isPilotSignalPresent = function () {
            return this.$$currentData.pilotSignal.powerDecibel > this.$$powerThreshold;
        };

        RSMM.prototype.receive = function (carrierDetail, time) {
            var
                pilotSignal,
                state = RxStateMachine.STATE.NO_INPUT
            ;

            // grab current data, this will be available at all handlers that will be called back by $$stateMachine
            this.$$currentData = {
                pilotSignal: carrierDetail[_RxStateMachineManager.OFDM_PILOT_SIGNAL_INDEX],  // alias for pilot
                carrierDetail: carrierDetail
            };
            pilotSignal = this.$$currentData.pilotSignal;

            if (this.$$isInputReallyConnected(pilotSignal.powerDecibel)) {
                // TODO add some kind of 'schmitt trigger' logic here to cleanup noise at signal transitions
                state = this.$$stateMachine.getState(this.$$isPilotSignalPresent(), time);
            }

            return {
                state: state,
                // TODO clean that mess below, move data to some dedicated fields in return object
                power: (
                    '<br/>' +
                    'avgNoisePower: ' + Math.round(this.$$averageNoisePower * 100) / 100 + '<br/>' +
                    'avgSignalPower: ' + Math.round(this.$$averageSignalPower * 100) / 100 + ' <br/>' +
                    '&nbsp;&nbsp;&nbsp;delta: ' + Math.round((this.$$averageSignalPower - this.$$averageNoisePower) * 100) / 100 + ' <br/>' +
                    'powerThreshold: ' + Math.round(this.$$powerThreshold * 100) / 100 + ' <br/>' +
                    'minGuardPower: ' + Math.round(this.$$minGuardPower * 100) / 100 + ' sampleSize: ' + this.$$minGuardPowerSampleSize + '<br/>' +
                    'maxSignalPower: ' + Math.round(this.$$maxSignalPower * 100) / 100 + ' sampleSize: ' + this.$$maxSignalPowerSampleSize + '<br/>' +
                    '&nbsp;&nbsp;&nbsp;delta: ' + Math.round((this.$$maxSignalPower - this.$$minGuardPower) * 100) / 100 + ' <br/>'
                )
            };
        };

        return RSMM;
    }

    return _RxStateMachineManager();        // TODO change it to dependency injection

})();
