const domain = 'informationComputing' as const

export const informationComputingQuantityKindData = {
  'informationComputing.AbsoluteTypographicMeasurement': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: [
      'Ao',
      'AU',
      '[Btu_IT].[lbf_av]-1',
      '[ch_br]',
      'cm',
      'dam',
      'dm',
      '[fth_i]',
      '[ft_i]',
      '[ft_us]',
      '[fur_us]',
      'fm',
      '[Ch]',
      'hm',
      '[in_i]',
      'km',
      '[ly]',
      'm',
      '[mi_i]',
      '[nmi_i]',
      '[mi_us]',
      'u[in_i]',
      'um',
      '[mil_i]',
      'm[in_i]',
      'mm',
      'nm',
      'pc',
      '[pca]',
      '[pnt]',
      'pm',
      '[rd_br]',
      '[yd_i]',
    ],
  },
  'informationComputing.AreaBitDensity': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['bit.m-2', 'Gibit.m-2', 'Kibit.m-2', 'Mibit.m-2', 'Tibit.m-2'],
  },
  'informationComputing.AreicDataVolume': {
    domain,
    tensorOrder: 0,
    description:
      'volume of data, which is usually dependent on the respective complexity of the information or its coding procedure, divided by the related area',
    applicableUnits: ['m-2'],
  },
  'informationComputing.BandwidthDistanceProduct': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['m.s-1'],
  },
  'informationComputing.BandwidthLengthProduct': {
    domain,
    tensorOrder: 0,
    description:
      'parameter of transmission media for determination of frequency and length restrictions as reciprocal value of the multimode distortion corresponding to the product of maximum pulse frequency and maximum transmission distance',
    applicableUnits: ['m.s-1'],
  },
  'informationComputing.BinaryLogarithmicMedianInformationFlow': {
    domain,
    tensorOrder: 0,
    description:
      'ratio of the median information content divided by the expected value for the duration of a character, expressed as a logarithm to base 2',
    applicableUnits: ['s-1'],
  },
  'informationComputing.BitDataVolume': {
    domain,
    tensorOrder: 0,
    description:
      'name for a particular quantity of data on the basis of the binary digit "Bit" (basic indissoluble information unit) which can only assume a state of 1 or 0',
    applicableUnits: ['bit'],
  },
  'informationComputing.BitRate': { domain, tensorOrder: 0, description: undefined, applicableUnits: ['s-1'] },
  'informationComputing.BitTransmissionRate': {
    domain,
    tensorOrder: 0,
    description: 'speed with which one bit will be transmitted per second',
    applicableUnits: ['s-1'],
  },
  'informationComputing.ByteDataVolume': {
    domain,
    tensorOrder: 0,
    description: 'particular quantity of data based on a string consisting of 8 bits',
    applicableUnits: ['By'],
  },
  'informationComputing.ByteRate': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['By.s-1', 'GBy.s-1', 'MBy.s-1'],
  },
  'informationComputing.ByteTransmissionRate': {
    domain,
    tensorOrder: 0,
    description: 'speed with which 8 bits are transmitted',
    applicableUnits: ['By.s-1', 'GBy.s-1', 'MBy.s-1'],
  },
  'informationComputing.CommonLogarithmicMedianInformationFlow': {
    domain,
    tensorOrder: 0,
    description:
      'ratio of the median information content divided by the expected value for the duration of a character, expressed as a logarithm to base 10',
    applicableUnits: ['s-1'],
  },
  'informationComputing.DataRate': {
    domain,
    tensorOrder: 0,
    description:
      'The frequency derived from the period of time required to transmit one bit. This represents the amount of data transferred per second by a communications channel or a computing or storage device. Data rate is measured in units of bits per second (written "b/s" or "bps"), bytes per second (Bps), or baud. When applied to data rate, the multiplier prefixes "kilo-", "mega-", "giga-", etc. (and their abbreviations, "k", "M", "G", etc.) always denote powers of 1000. For example, 64 kbps is 64,000 bits per second. This contrasts with units of storage which use different prefixes to denote multiplication by powers of 1024, for example 1 kibibit = 1024 bits.',
    applicableUnits: ['bit.s-1', 'Ebit.s-1', 'Gbit.s-1', 'kbit.s-1', 'kBy.s-1', 'Mbit.s-1', 'Pbit.s-1', 'Tbit.s-1'],
  },
  'informationComputing.DatasetOfBits': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['Gibit', 'Gbit', 'Kibit', 'kbit', 'Mibit', 'Mbit', 'Pbit', 'Tbit'],
  },
  'informationComputing.DatasetOfBytes': { domain, tensorOrder: 0, description: undefined, applicableUnits: ['By'] },
  'informationComputing.DataTransmissionRate': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['bit.s-1'],
  },
  'informationComputing.DigitRate': { domain, tensorOrder: 0, description: undefined, applicableUnits: ['Bd'] },
  'informationComputing.DotsPerInch': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['{dot}/[in_i]'],
  },
  'informationComputing.DutyCycle': {
    domain,
    tensorOrder: 0,
    description: 'A duty cycle or power cycle is the fraction of one period in which a signal or system is active.',
    applicableUnits: ['{fraction}', '%'],
  },
  'informationComputing.FloatingPointCalculationCapability': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['s-1'],
  },
  'informationComputing.Gain': {
    domain,
    tensorOrder: 0,
    description:
      'A general term used to denote an increase in signal power or signal strength in transmission from one point to another. Gain is usually expressed in decibels and is widely used to denote transducer gain. An increase or amplification. In radar there are two general usages of the term: (a) antenna gain, or gain factor, is the ratio of the power transmitted along the beam axis to that of an isotropic radiator transmitting the same total power; (b) receiver gain, or video gain, is the amplification given a signal by the receiver.',
    applicableUnits: ['{fraction}', '%'],
  },
  'informationComputing.InformationContent': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['bit'],
  },
  'informationComputing.InformationContentExpressedAsALogarithmToBase10': {
    domain,
    tensorOrder: 0,
    description:
      'I(xi) as the information content I(xi) of a result xi (e.g. the occurrence of a character xi) is the common logarithm of the reciprocal of the probability p(xi) of its occurrence, i.e.: l(x) lg 1/p(x) Hart, where p(x) is the probability of the event x',
    applicableUnits: ['dB'],
  },
  'informationComputing.InformationContentExpressedAsALogarithmToBase2': {
    domain,
    tensorOrder: 0,
    description:
      'I(xi) as the information content I(xi) of a result xi (e.g. the occurrence of a character xi) is the binary logarithm of the reciprocal of the probability p(xi) of its occurrence, i.e.: l(x) lb 1/p(x) Sh, where p(x) is the probability of the event x',
    applicableUnits: ['bit'],
  },
  'informationComputing.InformationContentExpressedAsALogarithmToBaseE': {
    domain,
    tensorOrder: 0,
    description:
      'I(xi) as the information content I(xi) of a result xi (e.g. the occurrence of a character xi) is the natural logarithm of the reciprocal of the probability p(xi) of its occurrence, i.e.: l(x) ln 1/p(x) nat, where p(x) is the probability of the event x',
    applicableUnits: ['Np'],
  },
  'informationComputing.InformationEntropy': {
    domain,
    tensorOrder: 0,
    description:
      'Information Entropy is a concept from information theory. It tells how much information there is in an event. In general, the more uncertain or random the event is, the more information it will contain. The concept of information entropy was created by a mathematician. He was named Claude Elwood Shannon. It has applications in many areas, including lossless data compression, statistical inference, cryptography and recently in other disciplines as biology, physics or machine learning.',
    applicableUnits: [
      'bit',
      'By',
      'Ebit',
      'EBy',
      'GiBy',
      'GBy',
      'KiBy',
      'kBy',
      'MiBy',
      'MBy',
      'PBy',
      'Tibit',
      'TiBy',
      'TBy',
    ],
  },
  'informationComputing.InformationFlowRate': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['s-1'],
  },
  'informationComputing.LinearBitDensity': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['bit.m-1', 'Gibit.m-1', 'Gbit.m-1', 'Kibit.m-1', 'Mibit.m-1', 'Tibit.m-1'],
  },
  'informationComputing.LineicDataVolume': {
    domain,
    tensorOrder: 0,
    description:
      'number of data, usually dependent on the respective information complexity or its coding procedure, divided by the related length',
    applicableUnits: ['m-1'],
  },
  'informationComputing.LineicResolution': {
    domain,
    tensorOrder: 0,
    description:
      'graphic resolution capacity of output devices such as printers or of data acquisition such as scanners, as a number of pixels per length',
    applicableUnits: ['{dot}/[in_i]'],
  },
  'informationComputing.LogarithmicMedianInformationFlow_SourceToBase10': {
    domain,
    tensorOrder: 0,
    description:
      'ratio of the median information content divided by the expected value for the duration of a character, expressed as a logarithm to base 10',
    applicableUnits: ['s-1'],
  },
  'informationComputing.LogarithmicMedianInformationFlow_SourceToBase2': {
    domain,
    tensorOrder: 0,
    description:
      'ratio of the median information content divided by the expected value for the duration of a character, expressed as a logarithm to base 2',
    applicableUnits: ['s-1'],
  },
  'informationComputing.LogarithmicMedianInformationFlow_SourceToBaseE': {
    domain,
    tensorOrder: 0,
    description:
      'ratio of the median information content divided by the expected value for the duration of a character, expressed as a logarithm to base e',
    applicableUnits: ['s-1'],
  },
  'informationComputing.NaturalLogarithmicMedianInformationFlow': {
    domain,
    tensorOrder: 0,
    description:
      'ratio of the median information content divided by the expected value for the duration of a character, expressed as a logarithm to base e',
    applicableUnits: ['s-1'],
  },
  'informationComputing.PictureElement': {
    domain,
    tensorOrder: 0,
    description:
      'smallest element of a display space (cell size) of a digitized two-dimensional field representation of an image which has an address (x and y coordinates corresponding to its position in the field) and a specific brightness value',
    applicableUnits: ['{pixel}'],
  },
  'informationComputing.SignalStrength': {
    domain,
    tensorOrder: 0,
    description:
      'In telecommunications, particularly in radio, signal strength refers to the magnitude of the electric field at a reference point that is a significant distance from the transmitting antenna. It may also be referred to as received signal level or field strength. Typically, it is expressed in voltage per length or signal power received by a reference antenna. High-powered transmissions, such as those used in broadcasting, are expressed in dB-millivolts per metre (dBmV/m).',
    applicableUnits: ['kV.m-1', 'MV.m-1', 'uV.m-1', 'mV.m-1', 'V.cm-1', 'V.[in_i]-1', 'V.m-1', 'V.mm-1', '10.nV.cm-1'],
  },
  'informationComputing.SymbolTransmissionRate': {
    domain,
    tensorOrder: 0,
    description: 'rate, at which a symbol, consisting of one or more bits, is transmitted per second',
    applicableUnits: ['Bd'],
  },
  'informationComputing.VideoFrameRate': {
    domain,
    tensorOrder: 0,
    description:
      'Frame rate (also known as frame frequency) is the frequency (rate) at which an imaging device produces unique consecutive images called frames. The term applies equally well to computer graphics, video cameras, film cameras, and motion capture systems. Frame rate is most often expressed in frames per second (FPS) and is also expressed in progressive scan monitors as hertz (Hz).',
    applicableUnits: ['s-1{frame}'],
  },
  'informationComputing.VolumetricBitDensity': {
    domain,
    tensorOrder: 0,
    description: undefined,
    applicableUnits: ['bit.m-3', 'Gibit.m-3', 'Kibit.m-3', 'Mibit.m-3', 'Tibit.m-3'],
  },
  'informationComputing.VolumicDataQuantity': {
    domain,
    tensorOrder: 0,
    description:
      'amount of data, which is usually dependent on the respective complexity of the information or its coding procedure, divided by the related volume',
    applicableUnits: ['m-3'],
  },
} as const
